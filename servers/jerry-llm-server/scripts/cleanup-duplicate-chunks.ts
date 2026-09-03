/**
 * 存量知识库文本块内容级去重清理脚本（一次性维护工具）
 *
 * 背景：addDocuments 的 chunk_hash 幂等去重上线前，legacy 上传路径
 * （/knowledge/upload）重复上传同名文件时 BM25 侧会按 source+chunk_index 清理，
 * 但 ChromaDB 侧从不清理，导致向量重复累积（检索返回完全相同的重复块）。
 * 本脚本对存量数据做一次性清理：按 (versionId, source, 内容hash) 分组，
 * 每组保留时间戳最新的一条，删除其余。
 *
 * 分组键与 addDocuments 的 deduplicateTextChunks 作用域一致：
 *   - 含 versionId：不同版本的归档/活跃向量不会互相删除（回滚功能不受影响）
 *   - 仅处理文本块；图片块有自己的 image_hash 去重机制，不在此处理
 *
 * 用法：
 *   pnpm --filter jerry-llm-server dedup:cleanup            # dry-run：只预览待删除数量
 *   pnpm --filter jerry-llm-server dedup:cleanup -- --apply # 实际执行删除
 *
 * 注意：运行前请确认 ChromaDB / BM25 持久化目录可写；建议先 dry-run 看预览。
 */
import crypto from 'crypto';
import {
  initializeVectorStore,
  getBM25Index,
  getBM25DocumentStore,
} from '../src/fundamentals/vector-store/store-state.js';
import {
  initializeBM25Index,
  saveBM25Index,
} from '../src/fundamentals/vector-store/bm25-index.js';

// ==================== 工具函数 ====================

function computeHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** 从块 ID（doc_<ts>_<rand>_<i> / img_<ts>_...）解析插入时间戳，解析失败返回 0 */
function parseIdTimestamp(id: string): number {
  const parts = id.split('_');
  const ts = Number(parts[1]);
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * 构建分组键：(versionId, source, 内容hash)
 * 与 addDocuments 内 deduplicateTextChunks 的作用域保持一致
 */
function buildGroupKey(
  meta: Record<string, any> | undefined,
  content: string,
): string {
  const versionId =
    meta?.versionId !== undefined ? String(meta.versionId) : '';
  const source = meta?.source || 'unknown';
  return `${versionId}__${source}__${computeHash(content)}`;
}

interface GroupEntry {
  id: string;
  ts: number;
}

// ==================== 主流程 ====================

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(
    `=== 知识库文本块去重清理（${apply ? '实际删除模式' : 'dry-run 预览模式'}）===\n`,
  );

  // 1. ChromaDB 侧：全量拉取文本块，按内容分组找重复
  const store = await initializeVectorStore();
  const collection = store.collection;
  if (!collection) {
    console.error('ChromaDB 集合不可用，退出');
    process.exit(1);
  }

  const all = await collection.get();
  console.log(`ChromaDB 共 ${all.ids.length} 个块`);

  const groups = new Map<string, GroupEntry[]>();
  for (let i = 0; i < all.ids.length; i++) {
    const meta = all.metadatas?.[i] as Record<string, any> | undefined;
    // 图片块有自己的 image_hash 去重机制，不在此处理
    if (meta?.chunk_type === 'image') continue;
    const content = all.documents?.[i] ?? '';
    if (!content) continue;

    const key = buildGroupKey(meta, content);
    const entries = groups.get(key) ?? [];
    entries.push({ id: all.ids[i], ts: parseIdTimestamp(all.ids[i]) });
    groups.set(key, entries);
  }

  // 每组保留时间戳最新的一条，其余标记删除
  const idsToDelete: string[] = [];
  let duplicateGroups = 0;
  for (const entries of groups.values()) {
    if (entries.length <= 1) continue;
    duplicateGroups++;
    entries.sort((a, b) => a.ts - b.ts);
    idsToDelete.push(...entries.slice(0, -1).map((e) => e.id));
  }

  console.log(
    `文本块分组：${groups.size} 组，其中 ${duplicateGroups} 组存在重复`,
  );
  console.log(`ChromaDB 待删除：${idsToDelete.length} 个重复块`);

  if (idsToDelete.length === 0) {
    console.log('\n未发现重复块，无需清理');
    return;
  }

  // 2. BM25 侧：同样的分组逻辑（内容存在 documentStore 中）
  await initializeBM25Index();
  const bm25Index = getBM25Index();
  const bm25DocumentStore = getBM25DocumentStore();

  const bm25IdsToDelete: string[] = [];
  if (bm25Index) {
    const bm25Groups = new Map<string, GroupEntry[]>();
    for (const [id, doc] of bm25DocumentStore.entries()) {
      const meta = doc.metadata;
      if (meta?.chunk_type === 'image') continue;
      if (!doc.content) continue;

      const key = buildGroupKey(meta, doc.content);
      const entries = bm25Groups.get(key) ?? [];
      entries.push({ id, ts: parseIdTimestamp(id) });
      bm25Groups.set(key, entries);
    }

    for (const entries of bm25Groups.values()) {
      if (entries.length <= 1) continue;
      entries.sort((a, b) => a.ts - b.ts);
      bm25IdsToDelete.push(...entries.slice(0, -1).map((e) => e.id));
    }
    console.log(`BM25 待删除：${bm25IdsToDelete.length} 个重复条目`);
  }

  // 3. 执行删除
  if (!apply) {
    console.log('\n[dry-run] 以上为预览结果。确认无误后执行实际删除：');
    console.log(
      '  pnpm --filter jerry-llm-server dedup:cleanup -- --apply',
    );
    return;
  }

  await collection.delete({ ids: idsToDelete });
  console.log(`已从 ChromaDB 删除 ${idsToDelete.length} 个重复块`);

  if (bm25Index && bm25IdsToDelete.length > 0) {
    for (const id of bm25IdsToDelete) {
      try {
        bm25Index.remove(id);
        bm25DocumentStore.delete(id);
      } catch {
        /* 条目可能已不存在 */
      }
    }
    await saveBM25Index();
    console.log(`已从 BM25 索引删除 ${bm25IdsToDelete.length} 个重复条目`);
  }

  console.log('\n=== 清理完成 ===');
}

main().catch((err) => {
  console.error('清理脚本执行失败:', err);
  process.exit(1);
});
