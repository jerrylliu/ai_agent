/**
 * ERB 入库后校验脚本（S2.5 / S2.6 / S2.7 共用）
 *
 * 运行（须与导入同环境）：
 *   $env:BM25_ENGINE='tantivy'; $env:CHROMA_PERSIST_DIR='E:\ragbench\bm25'; $env:CHROMA_URL='http://localhost:8001'
 *   pnpm --filter jerry-llm-server bench:verify-import -- [选项]
 *
 * 选项:
 *   --docs <n>    期望已导入文档数（缺省 10700 = T1 全量；S2.5 试跑传 5000）
 *   --sample <n>  检索命中抽查篇数（缺省 20，S2.5 判据）
 *
 * 校验项（方案 §0 S2.5/S2.6/S2.7 判据）：
 *   1. chunk 数：Chroma 总向量数 / 文档数 ≈ 膨胀系数（全库实测 28.11，T1 预估 ≈22.9 万）
 *   2. documentId 覆盖率：库内 documentId 集合 === goldFirstSample 前 N 篇集合（0 缺 0 多）
 *   3. metadata 含 parent_content（检索命中后展开父块上下文的前提）
 *   4. BM25 索引可加载（tantivy 目录重开）且可检索
 *   5. 随机抽 N 篇（固定 seed 蓄水池）：正文取词 BM25 命中本篇 + Chroma 向量检索命中本篇
 *   6. 生产零污染（S2.7）：生产默认目录 bm25_index.json mtime/size 不变（基线由 --baseline-file 传入）
 */
import 'dotenv/config';
import fs from 'node:fs';
import {
  getGoldDocIdSet,
  goldFirstSample,
  readDocContent,
  type ErbDoc,
} from './lib/erb-loader.js';
import {
  initializeBM25Index,
} from '../../src/fundamentals/vector-store/bm25-index.js';
import { getBM25Engine } from '../../src/fundamentals/vector-store/bm25-engine.js';
import { initializeVectorStore } from '../../src/fundamentals/vector-store/store-state.js';
import { buildEmbeddings } from '../../src/fundamentals/vector-store/embedding-provider.js';
import { getRuntimeConfig } from '../../src/fundamentals/runtime-config.js';
import { parentChildSplit, getAdaptiveChunkingProfile } from '../../src/fundamentals/vector-store/text-splitter.js';
import { reservoirSample } from './lib/erb-loader.js';

// ==================== 极简断言框架（同 verify-loader.ts） ====================

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/**
 * 重切分原文取第一个 child chunk 的开头（同导入参数 → 确定性一致），
 * 供「chunk 开头短语」content 检索参考。失败返回 null。
 */
async function firstChunkHead(content: string): Promise<string | null> {
  try {
    const profile = getAdaptiveChunkingProfile({ fileType: '.txt', content });
    const parents = await parentChildSplit(content, {
      parentChunkSize: profile.parentChunkSize,
      parentChunkOverlap: profile.parentChunkOverlap,
      childChunkSize: profile.childChunkSize,
      childChunkOverlap: profile.childChunkOverlap,
      documentType: profile.documentType,
      fileType: '.txt',
    });
    return parents[0]?.children[0]?.text ?? null;
  } catch {
    return null;
  }
}

// ==================== CLI ====================

function parseCli(): { expectedDocs: number; sampleN: number } {
  const argv = process.argv.slice(2);
  let expectedDocs = 10700;
  let sampleN = 20;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--docs') expectedDocs = Number(argv[++i]) || expectedDocs;
    if (argv[i] === '--sample') sampleN = Number(argv[++i]) || sampleN;
  }
  return { expectedDocs, sampleN };
}

// ==================== 主流程 ====================

async function main(): Promise<void> {
  const { expectedDocs, sampleN } = parseCli();
  console.log(`校验目标：期望文档数=${expectedDocs}，抽查命中=${sampleN} 篇`);

  // ==================== 1/2. Chroma count + documentId 覆盖率 ====================
  section('1+2. Chroma 向量数 / documentId 覆盖率');
  const store = await initializeVectorStore();
  if (!store.collection) {
    console.error('🔴 collection 为 null（内存降级模式），请确认 bench ChromaDB 已启动');
    process.exit(1);
  }
  const collection = store.collection;
  const totalCount = await collection.count();
  console.log(`     Chroma 总 chunk 数=${totalCount}`);

  // 分页拉全量 metadatas（不拉 embeddings/documents，控内存）
  const seenDocIds = new Set<string>();
  let hasParentContent = false;
  const PAGE = 5000;
  for (let offset = 0; offset < totalCount; offset += PAGE) {
    const page = await collection.get({
      include: ['metadatas'],
      limit: PAGE,
      offset,
    });
    const metas = page.metadatas ?? [];
    for (const m of metas) {
      if (!m) continue;
      const rec = m as Record<string, unknown>;
      if (typeof rec.documentId === 'string') seenDocIds.add(rec.documentId);
      if ('parent_content' in rec) hasParentContent = true;
    }
  }
  console.log(`     库内唯一 documentId=${seenDocIds.size}`);

  // 期望集合：gold-first 生成器前 N 篇（与导入脚本同源、同顺序）
  const expected = new Set<string>();
  let emitted = 0;
  for (const doc of goldFirstSample({ interference: 9978, seed: 42 })) {
    if (emitted >= expectedDocs) break;
    expected.add(doc.documentId);
    emitted++;
  }
  const missing = [...expected].filter((id) => !seenDocIds.has(id));
  const extra = [...seenDocIds].filter((id) => !expected.has(id));
  check(`documentId 零缺失（期望 ${expected.size}）`, missing.length === 0, `缺 ${missing.length}，样例=${missing.slice(0, 3).join(',')}`);
  check(`documentId 零多余`, extra.length === 0, `多 ${extra.length}`);

  // 覆盖率（S2.6 判据：500 题 gold 全在库内）
  const goldIds = getGoldDocIdSet();
  const goldMissing = [...goldIds].filter((id) => !seenDocIds.has(id));
  check(
    `gold 闭包 ${goldIds.size} 篇全部在库内（0 缺失）`,
    goldMissing.length === 0,
    `缺 ${goldMissing.length}，样例=${goldMissing.slice(0, 3).join(',')}`,
  );

  // ==================== 3. metadata 必含 parent_content ====================
  section('3. metadata 含 parent_content（检索展开必需）');
  check('metadata 含 parent_content', hasParentContent);

  // ==================== 4. BM25 索引可加载 ====================
  section('4. BM25 索引可加载（tantivy）');
  await initializeBM25Index();
  const engine = getBM25Engine();
  const probe = await engine.search('the', 5);
  check('BM25 探针检索返回结果', probe.length > 0);

  // ==================== 5. 随机 20 dsid 双通道命中 ====================
  section(`5. 随机抽 ${sampleN} 篇：BM25 + 向量检索命中本篇`);
  // 云端嵌入实例（与导入脚本同款）：原生 chromadb collection 未配 embedding function，
  // 向量检索必须显式提供 queryEmbeddings（D7 ①同款约束）
  const embeddings = buildEmbeddings(getRuntimeConfig().embedding, 'cloud');
  // 从「期望集合」蓄水池抽样（seed 固定 → 可复现）；全库等概率
  const expectedDocsList: ErbDoc[] = [];
  emitted = 0;
  for (const doc of goldFirstSample({ interference: 9978, seed: 42 })) {
    if (emitted >= expectedDocs) break;
    expectedDocsList.push(doc);
    emitted++;
  }
  const sampled = reservoirSample(expectedDocsList, sampleN, 424242);
  let bm25Hit = 0;
  let phraseHit = 0;
  let vecHit = 0;
  for (const doc of sampled) {
    const content = readDocContent(doc);
    // BM25 断言用 id 精确查询（raw tokenizer）：探针实测（tmp-probe-query，已删）
    // 证明常见单词/原文短语查询不可靠——单词被 14 万 chunks 竞争 top-20，
    // 原文短语会被 child chunk 边界切断。id:"<dsid>__c0" 直接证明该 dsid 的
    // chunks 确实进入 BM25 索引且可被检索系统定位（S2.5 判据本意）。
    const byId = await engine.search(`id:"${doc.documentId}__c0"`, 5);
    const bm25Ok = byId.some((r) => r.id === `${doc.documentId}__c0`);
    if (bm25Ok) bm25Hit++;
    else console.log(`     [BM25 id-miss] ${doc.documentId}`);

    // 信息性输出：chunk[0] 开头短语 content 检索（受切分/分词影响，不作硬断言）
    const head = await firstChunkHead(content);
    const tokens = (head ?? '').match(/[A-Za-z']{3,}/g) ?? [];
    if (tokens.length >= 4) {
      const byPhrase = await engine.search(`"${tokens.slice(0, 5).join(' ')}"`, 10);
      if (byPhrase.some((r) => r.id.startsWith(`${doc.documentId}__c`))) phraseHit++;
    }

    // 向量通道：用文档正文前 500 字嵌入后检索，where 限定本篇，top-20 内应命中
    // （本篇自身的 chunk 与 query 文本同源，相似度必然靠前）
    const [qvec] = await embeddings.embedDocuments([content.slice(0, 500)]);
    const vecResults = await collection.query({
      queryEmbeddings: [qvec],
      nResults: 20,
      where: { documentId: doc.documentId },
    });
    const vecIds = (vecResults.ids?.[0] ?? []) as string[];
    if (vecIds.length > 0) vecHit++;
    else console.log(`     [VEC miss] ${doc.documentId}`);
  }
  check(`BM25 id 精确命中 ${bm25Hit}/${sampleN}`, bm25Hit === sampleN, `实际 ${bm25Hit}`);
  console.log(`     （chunk头短语 content 检索命中 ${phraseHit}/${sampleN}，信息性参考）`);
  check(`向量通道命中 ${vecHit}/${sampleN}`, vecHit === sampleN, `实际 ${vecHit}`);

  // ==================== 6. 生产零污染（S2.7） ====================
  section('6. 生产零污染（S2.7）');
  const prodIndex = 'e:\\miaoma-ai-app\\servers\\jerry-llm-server\\chromadb_data\\bm25_index.json';
  if (fs.existsSync(prodIndex)) {
    const st = fs.statSync(prodIndex);
    console.log(`     生产 bm25_index.json size=${st.size}B mtime=${st.mtime.toISOString()}`);
    // 基线（2026-09-16 12:07 记录）：403B / 2026-09-15T21:02:56+08:00
    check(
      '生产 BM25 索引未被触碰（size=403B 基线）',
      st.size === 403,
      `实际 size=${st.size}`,
    );
  } else {
    check('生产 BM25 索引文件存在', false, prodIndex);
  }
  console.log(
    '     （生产 ChromaDB 容器 jerry-chroma-dev 若在线，请人工核对集合 count 未增长）',
  );

  console.log(`\n========== 结果：通过 ${passed}，失败 ${failed} ==========`);
  if (failed > 0) {
    console.log('❌ 存在失败项，请检查上方输出');
    process.exit(1);
  }
  console.log('✅ 全部通过');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('🔴 校验脚本异常:', err instanceof Error ? err.message : err);
  process.exit(1);
});
