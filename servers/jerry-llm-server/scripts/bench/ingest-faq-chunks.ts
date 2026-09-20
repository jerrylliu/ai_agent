/**
 * ERB FAQ 副本入库脚本（benchmark-only，路径 1 方法 A 第 2 阶段）
 *
 * 读取 generate-faq-chunks.ts 产出的 FAQ JSONL，把每条 FAQ 作为独立 chunk
 * 写入评测知识库（ChromaDB 向量 + tantivy BM25 双写），参与混合检索：
 *   - chunk id：`${dsid}__faq${i}`（评测按 split('__')[0] 还原 dsid，自动生效）
 *   - metadata：与 ErbChunkMetadata 对齐 + chunk_type: 'faq'；parent_content
 *     携带文档正文（≤6000 字符），检索命中 FAQ 后由 vector-search 展开为文档
 *     上下文（与 parent_content 修复 S4.0 同口径，生成侧不缺料）
 *   - 幂等：按 id 探测已存在的先删后写（Chroma delete + BM25 deleteFrom），可重复执行
 *
 * 🔴 引擎硬约束：必须 BM25_ENGINE=tantivy（评测库按 tantivy 落盘，
 *    minisearch 会静默新建空内存索引导致混合退化纯向量）。
 * 🔴 生产隔离：CHROMA_PERSIST_DIR 必须显式覆盖、CHROMA_URL ≠ 生产 8000。
 *
 * 检索侧零改动：FAQ 块与普通块同 collection 同结构，混合检索自然命中；
 * 评测 document_ids 按 metadata.documentId 提取，FAQ 命中即 gold 文档命中。
 *
 * 用法：
 *   node --import ./scripts/ts-loader.mjs --experimental-transform-types \
 *     scripts/bench/ingest-faq-chunks.ts --input E:\ragbench\bm25\hyde\faq-pilot.jsonl
 *
 * 运行前提：CHROMA_URL=http://localhost:8001 / CHROMA_PERSIST_DIR=E:\ragbench\bm25
 *           / BM25_ENGINE=tantivy（Chroma bench 容器须健康）
 */

// 必须最先加载 .env（config.ts zod fail-fast 依赖完整环境变量）
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../src/fundamentals/config.js';
import { logger, closeLogger } from '../../src/fundamentals/logger.js';
import { getRuntimeConfig } from '../../src/fundamentals/runtime-config.js';
import {
  buildEmbeddings,
  EMBEDDING_PROVIDER_PRESETS,
} from '../../src/fundamentals/vector-store/embedding-provider.js';
import { initializeVectorStore } from '../../src/fundamentals/vector-store/store-state.js';
import {
  initializeBM25Index,
  addToBM25Index,
  deleteFromBM25Index,
  saveBM25Index,
} from '../../src/fundamentals/vector-store/bm25-index.js';
import { readDocContent } from './lib/erb-loader.js';
import { chunkHash } from './lib/erb-metadata.js';

// ==================== 常量与守卫 ====================

const MODULE = 'BenchFaqIngest';

const PROD_CHROMA_URL = 'http://localhost:8000';

/** parent_content 上限：ERB 文档普遍短小，6000 字符足以覆盖整篇（超出截断） */
const PARENT_CONTENT_MAX = 6000;

/** 单文档嵌入重试（429 退避 2s/4s/6s；OpenAIEmbeddings 内部已有 maxRetries=3） */
const EMBED_RETRY_MAX = 3;
const EMBED_RETRY_BASE_MS = 2000;

function assertEnvGuards(): void {
  const problems: string[] = [];
  if (!process.env.CHROMA_PERSIST_DIR) {
    problems.push('CHROMA_PERSIST_DIR 未显式设置（生产隔离红线：禁止默认指向生产库）');
  }
  if ((process.env.CHROMA_URL ?? '') === PROD_CHROMA_URL) {
    problems.push(`CHROMA_URL 指向生产实例 ${PROD_CHROMA_URL}`);
  }
  if (process.env.BM25_ENGINE !== 'tantivy') {
    problems.push('BM25_ENGINE 必须 = tantivy（评测库按 tantivy 落盘，引擎不一致会静默退化）');
  }
  if (problems.length > 0) {
    console.error('🔴 启动守卫拦截，拒绝运行：\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
}

// ==================== gracefulExit ====================

function scheduleForceExit(code: number): void {
  const t = setTimeout(() => process.exit(code), 6000);
  t.unref();
}

async function gracefulExit(code: number): Promise<never> {
  scheduleForceExit(code);
  try {
    await closeLogger();
  } catch {
    // 关日志失败不阻塞退出
  }
  process.exit(code);
}

// ==================== 类型 ====================

interface FaqRow {
  documentId: string;
  filePath: string;
  sourceType: string;
  faqs: Array<{ question: string; answer: string }>;
}

// ==================== 主流程 ====================

async function main(): Promise<void> {
  assertEnvGuards();

  // CLI：--input
  const inputIdx = process.argv.indexOf('--input');
  const inputPath =
    inputIdx !== -1 ? process.argv[inputIdx + 1] : 'E:\\ragbench\\bm25\\hyde\\faq-pilot.jsonl';
  if (!inputPath || !fs.existsSync(inputPath)) {
    console.error(`FAQ 输入文件不存在: ${inputPath}`);
    process.exit(1);
  }

  const rows: FaqRow[] = [];
  for (const line of fs.readFileSync(inputPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line) as FaqRow);
  }
  console.log(`读取 FAQ 行数: ${rows.length}（来自 ${inputPath}）`);
  if (rows.length === 0) {
    console.error('输入为空，无事可做');
    process.exit(1);
  }

  // 嵌入实例：与 bench 导入同款（显式 cloud，绕开 localEnabled 总开关）
  const embeddingConfig = getRuntimeConfig().embedding;
  const embeddings = buildEmbeddings(embeddingConfig, 'cloud');
  const batchHttpSize = EMBEDDING_PROVIDER_PRESETS[embeddingConfig.cloud.provider]?.batchSize ?? 10;

  const store = await initializeVectorStore();
  if (!store.collection) {
    throw new Error('向量存储处于内存降级模式（collection=null），请确认 bench ChromaDB 已启动');
  }
  const collection = store.collection;
  await initializeBM25Index();

  const stats = { docsOk: 0, docsSkipped: 0, chunksAdded: 0, embedCalls: 0 };
  let saveScheduled = false;

  try {
    for (const row of rows) {
      // 1. 读文档正文（parent_content 载体）；文档缺失则整篇跳过
      let docContent: string;
      try {
        docContent = readDocContent(row.filePath);
      } catch (error: any) {
        logger.warn('文档正文读取失败，跳过该篇 FAQ', {
          module: MODULE,
          documentId: row.documentId,
          error: error?.message ?? String(error),
        });
        stats.docsSkipped++;
        continue;
      }
      const parentContent = docContent.slice(0, PARENT_CONTENT_MAX);

      // 2. 构造 chunk（id 确定性 → 幂等覆盖）
      const ids: string[] = [];
      const texts: string[] = [];
      const metas: Array<Record<string, string | number | boolean>> = [];
      row.faqs.forEach((faq, i) => {
        const text = `Q: ${faq.question}\nA: ${faq.answer}`;
        ids.push(`${row.documentId}__faq${i}`);
        texts.push(text);
        metas.push({
          documentId: row.documentId,
          source: path.basename(row.filePath),
          source_type: row.sourceType,
          chunk_index: i,
          chunk_hash: chunkHash(text),
          chunk_role: 'child',
          parent_id: `${row.documentId}__faq_parent`,
          parent_content: parentContent,
          chunk_type: 'faq',
        });
      });

      // 3. 幂等探测：已存在的先删后写（BM25 引擎不允许重复 id）
      const existing = await collection.get({ ids, include: [] });
      const existingIds: string[] = (existing.ids ?? []) as string[];
      if (existingIds.length > 0) {
        await collection.delete({ ids: existingIds });
        for (const id of existingIds) deleteFromBM25Index(id);
        logger.info('FAQ chunk 已存在，先删后重写', {
          module: MODULE,
          documentId: row.documentId,
          residual: existingIds.length,
        });
      }

      // 4. 嵌入（FAQ 每篇 3-5 条，单次 HTTP 即可；429 指数退避）
      let vectors: number[][] | null = null;
      for (let attempt = 1; attempt <= EMBED_RETRY_MAX && !vectors; attempt++) {
        try {
          vectors = await embeddings.embedDocuments(texts);
          stats.embedCalls++;
        } catch (error: any) {
          if (attempt >= EMBED_RETRY_MAX) throw error;
          const wait = EMBED_RETRY_BASE_MS * attempt;
          logger.warn('嵌入失败，退避重试', {
            module: MODULE,
            documentId: row.documentId,
            attempt,
            waitMs: wait,
            error: error?.message ?? String(error),
          });
          await new Promise((r) => setTimeout(r, wait));
        }
      }

      // 5. ChromaDB + BM25 双写（skipSave=true，收尾统一落盘）
      await collection.add({ ids, embeddings: vectors!, metadatas: metas, documents: texts });
      for (let i = 0; i < ids.length; i++) {
        await addToBM25Index(ids[i], texts[i], metas[i], true);
      }
      stats.docsOk++;
      stats.chunksAdded += texts.length;
    }
  } finally {
    // 无论成功/中断，已写入的 BM25 增量必须落盘（与 bench 导入同契约）
    if (stats.docsOk > 0 && !saveScheduled) {
      saveScheduled = true;
      await saveBM25Index();
      console.log('BM25 索引已落盘');
    }
  }

  console.log(`\n=== FAQ 入库完成 ===`);
  console.log(
    `成功 ${stats.docsOk} 篇 / 跳过 ${stats.docsSkipped} 篇 / 写入 chunk ${stats.chunksAdded} 条 / 嵌入调用 ${stats.embedCalls} 次`,
  );
  logger.info('FAQ 入库完成', { module: MODULE, ...stats });
  await gracefulExit(0);
}

main().catch(async (error) => {
  console.error('FAQ 入库主流程异常:', error);
  logger.error('FAQ 入库主流程异常', {
    module: MODULE,
    error: error?.message ?? String(error),
    stack: error?.stack,
  });
  await gracefulExit(1);
});
