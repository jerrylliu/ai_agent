/**
 * ERB Wiki 主题页入库脚本（benchmark-only，LLM Wiki 门闩实验 第 2 阶段）
 *
 * 读取 generate-wiki-topics.ts 产出的主题页 JSONL，把每页作为独立 chunk
 * 写入评测知识库（ChromaDB 向量 + tantivy BM25 双写），参与混合检索：
 *   - chunk id：`${首成员dsid}__wiki_${topicId}`（与 FAQ 的 `${dsid}__faq${i}`
 *     同构，评测按 split('__')[0] 还原 dsid 时得到首成员 dsid）
 *   - 记分口径：metadata.documentId = 首成员 dsid（与 FAQ"派生块记分给源文档"
 *     同构）。已知低估：主题页实际覆盖多文档，命中只记首成员——报告需注明。
 *   - parent_content = 主题页正文：检索命中后由 vector-search 的 parent-child
 *     展开用正文替换 child 文本进入 LLM 上下文（与 FAQ/parent-child 同机制），
 *     即"合成的跨文档知识密度"真正到达生成侧。
 *   - 幂等：先按 chunk_type='wiki_topic' 全量清残留（防改版后 id 漂移），
 *     再按 id 先删后写（BM25 引擎不允许重复 id）。
 *
 * 🔴 引擎硬约束：必须 BM25_ENGINE=tantivy（评测库按 tantivy 落盘，
 *    minisearch 会静默新建空内存索引导致混合退化纯向量）。
 * 🔴 生产隔离：CHROMA_PERSIST_DIR 必须显式覆盖、CHROMA_URL ≠ 生产 8000。
 *
 * 用法：
 *   node --import ./scripts/ts-loader.mjs --experimental-transform-types \
 *     scripts/bench/ingest-wiki-topics.ts --input E:\ragbench\bm25\wiki-gate\wiki-topics.jsonl
 *
 * 运行前提：CHROMA_URL=http://localhost:8001 / CHROMA_PERSIST_DIR=E:\ragbench\bm25
 *           / BM25_ENGINE=tantivy（Chroma bench 容器须健康）
 */

// 必须最先加载 .env（config.ts zod fail-fast 依赖完整环境变量）
import 'dotenv/config';
import * as fs from 'fs';
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
import { chunkHash } from './lib/erb-metadata.js';

// ==================== 常量与守卫 ====================

const MODULE = 'BenchWikiIngest';

const PROD_CHROMA_URL = 'http://localhost:8000';

/** parent_content 上限（与 FAQ 同口径；主题页 body zod 上限 4000，不会触顶） */
const PARENT_CONTENT_MAX = 6000;

/** 单批嵌入重试（429 退避 2s/4s/6s；OpenAIEmbeddings 内部已有 maxRetries=3） */
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

// ==================== gracefulExit（见项目记忆：禁止裸 process.exit 挂起事件循环） ====================

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

interface TopicRow {
  topicId: string;
  title: string;
  body: string;
  /** 成员文档 id（升序）；[0] 为记分归属文档 */
  documentIds: string[];
  sourceType: string;
}

// ==================== 主流程 ====================

async function main(): Promise<void> {
  assertEnvGuards();

  // CLI：--input
  const inputIdx = process.argv.indexOf('--input');
  const inputPath =
    inputIdx !== -1
      ? process.argv[inputIdx + 1]
      : 'E:\\ragbench\\bm25\\wiki-gate\\wiki-topics.jsonl';
  if (!inputPath || !fs.existsSync(inputPath)) {
    console.error(`Wiki 输入文件不存在: ${inputPath}`);
    process.exit(1);
  }

  const rows: TopicRow[] = [];
  for (const line of fs.readFileSync(inputPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as TopicRow;
    if (!row.topicId || !row.body || !Array.isArray(row.documentIds) || row.documentIds.length < 2) {
      console.error(`非法行（缺字段或成员 <2 篇）：${row.topicId ?? '?'}`);
      process.exit(1);
    }
    rows.push(row);
  }
  console.log(`读取 Wiki 主题页行数: ${rows.length}（来自 ${inputPath}）`);
  if (rows.length === 0) {
    console.error('输入为空，无事可做');
    process.exit(1);
  }

  // 嵌入实例：与 bench 导入同款（显式 cloud，绕开 localEnabled 总开关）
  const embeddingConfig = getRuntimeConfig().embedding;
  const embeddings = buildEmbeddings(embeddingConfig, 'cloud');

  const store = await initializeVectorStore();
  if (!store.collection) {
    throw new Error('向量存储处于内存降级模式（collection=null），请确认 bench ChromaDB 已启动');
  }
  const collection = store.collection;
  await initializeBM25Index();

  const stats = { topicsOk: 0, topicsSkipped: 0, chunksAdded: 0, embedCalls: 0 };
  let saveScheduled = false;

  try {
    // 0. 全量清残留：按 chunk_type 枚举删除（防主题页改版后 id 漂移留下孤儿块）
    const stale = await collection.get({ where: { chunk_type: 'wiki_topic' }, include: [] });
    const staleIds = (stale.ids ?? []) as string[];
    if (staleIds.length > 0) {
      await collection.delete({ ids: staleIds });
      for (const id of staleIds) {
        try {
          await deleteFromBM25Index(id);
        } catch {
          // BM25 中不存在的 id 容忍（上次中断只删了一侧）
        }
      }
      logger.info('清理 wiki_topic 残留块', { module: MODULE, count: staleIds.length });
    }

    for (const row of rows) {
      const owner = row.documentIds[0];
      const chunkId = `${owner}__wiki_${row.topicId}`;
      const text = `【主题】${row.title}\n\n${row.body}`;
      const meta: Record<string, string | number | boolean> = {
        documentId: owner,
        source: 'wiki-topic',
        source_type: row.sourceType,
        chunk_index: 0,
        chunk_hash: chunkHash(text),
        chunk_role: 'child',
        parent_id: `wiki_${row.topicId}_parent`,
        parent_content: row.body.slice(0, PARENT_CONTENT_MAX),
        chunk_type: 'wiki_topic',
      };

      // 1. 幂等探测：已存在的先删后写
      const existing = await collection.get({ ids: [chunkId], include: [] });
      const existingIds: string[] = (existing.ids ?? []) as string[];
      if (existingIds.length > 0) {
        await collection.delete({ ids: existingIds });
        for (const id of existingIds) deleteFromBM25Index(id);
        logger.info('Wiki chunk 已存在，先删后重写', {
          module: MODULE,
          chunkId,
        });
      }

      // 2. 嵌入（单页单条，单次 HTTP；429 指数退避）
      let vectors: number[][] | null = null;
      for (let attempt = 1; attempt <= EMBED_RETRY_MAX && !vectors; attempt++) {
        try {
          vectors = await embeddings.embedDocuments([text]);
          stats.embedCalls++;
        } catch (error: any) {
          if (attempt >= EMBED_RETRY_MAX) throw error;
          const wait = EMBED_RETRY_BASE_MS * attempt;
          logger.warn('嵌入失败，退避重试', {
            module: MODULE,
            topicId: row.topicId,
            attempt,
            waitMs: wait,
            error: error?.message ?? String(error),
          });
          await new Promise((r) => setTimeout(r, wait));
        }
      }

      // 3. ChromaDB + BM25 双写（saveBM25Index 收尾统一落盘）
      await collection.add({
        ids: [chunkId],
        embeddings: vectors!,
        metadatas: [meta],
        documents: [text],
      });
      await addToBM25Index(chunkId, text, meta, true);
      stats.topicsOk++;
      stats.chunksAdded++;
    }
  } finally {
    // 无论成功/中断，已写入的 BM25 增量必须落盘（与 bench 导入同契约）
    if (stats.topicsOk > 0 && !saveScheduled) {
      saveScheduled = true;
      await saveBM25Index();
      console.log('BM25 索引已落盘');
    }
  }

  console.log(`\n=== Wiki 入库完成 ===`);
  console.log(
    `成功 ${stats.topicsOk} 页 / 写入 chunk ${stats.chunksAdded} 条 / 嵌入调用 ${stats.embedCalls} 次`,
  );
  logger.info('Wiki 入库完成', { module: MODULE, ...stats });
  await gracefulExit(0);
}

main().catch(async (error) => {
  console.error('Wiki 入库主流程异常:', error);
  logger.error('Wiki 入库主流程异常', {
    module: MODULE,
    error: error?.message ?? String(error),
    stack: error?.stack,
  });
  await gracefulExit(1);
});
