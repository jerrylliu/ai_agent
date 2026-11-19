/**
 * Wiki 主题块清理脚本（benchmark-only，LLM Wiki 门闩实验 收尾）
 *
 * 按 metadata chunk_type='wiki_topic' 枚举全部 wiki chunk（不依赖 id 规律，
 * 可捕获任何残留），从 ChromaDB 与 tantivy BM25 双删，恢复评测库基线。
 * 幂等：重复执行无害（删除 0 条也是合法结果）。
 *
 * 用法：node --import ./scripts/ts-loader.mjs --experimental-transform-types
 *        scripts/bench/cleanup-wiki-topics.ts [--dry-run]
 */

// 必须最先加载 .env（config.ts zod fail-fast 依赖完整环境变量）
import 'dotenv/config';
import { logger, closeLogger } from '../../src/fundamentals/logger.js';
import { initializeVectorStore } from '../../src/fundamentals/vector-store/store-state.js';
import {
  initializeBM25Index,
  deleteFromBM25Index,
  saveBM25Index,
} from '../../src/fundamentals/vector-store/bm25-index.js';

const MODULE = 'BenchWikiCleanup';

const PROD_CHROMA_URL = 'http://localhost:8000';

function assertEnvGuards(): void {
  const problems: string[] = [];
  if (!process.env.CHROMA_PERSIST_DIR) {
    problems.push('CHROMA_PERSIST_DIR 未显式设置');
  }
  if ((process.env.CHROMA_URL ?? '') === PROD_CHROMA_URL) {
    problems.push(`CHROMA_URL 指向生产实例 ${PROD_CHROMA_URL}`);
  }
  if (process.env.BM25_ENGINE !== 'tantivy') {
    problems.push('BM25_ENGINE 必须 = tantivy');
  }
  if (problems.length > 0) {
    console.error('🔴 启动守卫拦截：\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
}

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

async function main(): Promise<void> {
  assertEnvGuards();
  const dryRun = process.argv.includes('--dry-run');

  const store = await initializeVectorStore();
  if (!store.collection) {
    throw new Error('向量存储内存降级模式（collection=null），拒绝清理');
  }
  const collection = store.collection;
  await initializeBM25Index();

  // 1. 枚举全部 wiki chunk（按 metadata 过滤，不依赖 id 规律）
  const found = await collection.get({
    where: { chunk_type: 'wiki_topic' },
    include: [],
  });
  const ids = (found.ids ?? []) as string[];
  console.log(`发现 wiki_topic chunk: ${ids.length} 条`);
  if (ids.length === 0) {
    console.log('库中无 wiki 残留，无需清理');
    await gracefulExit(0);
  }

  if (dryRun) {
    console.log(`[dry-run] 将删除: ${ids.slice(0, 5).join(', ')} ... 共 ${ids.length} 条`);
    await gracefulExit(0);
  }

  // 2. 双删：ChromaDB + BM25（BM25 按逐 id 删，不存在的 id 容忍）
  await collection.delete({ ids });
  let bm25Deleted = 0;
  for (const id of ids) {
    try {
      await deleteFromBM25Index(id);
      bm25Deleted++;
    } catch (error: any) {
      // BM25 中不存在的 id（如上次中断只删了一侧）容忍继续
      logger.warn('BM25 删除失败（容忍继续）', {
        module: MODULE,
        chunkId: id,
        error: error?.message ?? String(error),
      });
    }
  }
  await saveBM25Index();

  // 3. 复验归零
  const verify = await collection.get({ where: { chunk_type: 'wiki_topic' }, include: [] });
  const remaining = ((verify.ids ?? []) as string[]).length;
  console.log(`\n=== Wiki 清理完成 ===`);
  console.log(`ChromaDB 删除 ${ids.length} 条 / BM25 删除 ${bm25Deleted} 条 / 复验残留 ${remaining} 条`);
  logger.info('Wiki 清理完成', {
    module: MODULE,
    chromaDeleted: ids.length,
    bm25Deleted,
    remaining,
  });
  await gracefulExit(remaining === 0 ? 0 : 2);
}

main().catch(async (error) => {
  console.error('Wiki 清理主流程异常:', error);
  logger.error('Wiki 清理主流程异常', {
    module: MODULE,
    error: error?.message ?? String(error),
    stack: error?.stack,
  });
  await gracefulExit(1);
});
