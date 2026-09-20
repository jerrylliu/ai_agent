/**
 * ERB 膨胀比压测（阶段 0 / 表 3.1 #2）——纯本地、零外部依赖
 *
 * 运行：pnpm --filter jerry-llm-server bench:measure-expansion
 * 或：  node --import ./scripts/ts-loader.mjs --experimental-transform-types scripts/bench/measure-expansion.ts
 *
 * 目的：
 *   用【生产同款切分链路】对抽样文档切块，测出：
 *     1. 平均每篇文档的父块数 / 子块数（子块数 = 向量数，父块不入库）
 *     2. 字符膨胀比 = 子块总字符 / 原文总字符（overlap 导致的膨胀）
 *     3. 按 source_type 真实文档数外推 511,962 篇的【总向量数】→ 决定 ChromaDB 容量
 *     4. profile 分布（多少篇被判为 markdown 档 vs text 档）
 *
 * 🔴 精确镜像生产（vector-crud.ts#L225-L246）：
 *     profile = getAdaptiveChunkingProfile({ fileType: '.txt', content })
 *     chunks  = await parentChildSplit(text, { ...profile, fileType: '.txt' })
 *   ERB 文件扩展名恒为 .txt，但正文可能是 markdown，故必须把 content 传给
 *   getAdaptiveChunkingProfile 让其做 isMarkdownContent 检测（与生产一致）。
 *
 * 顺带 smoke 验证 S1.3 erb-metadata.ts（编译 + 字段 + chunk_hash 一致性）。
 *
 * CLI：
 *   --per-type N   每个 source_type 抽样篇数（默认 200 → 共 1800 篇）
 *   --seed N       抽样种子（默认 42，确定性可复现）
 *   --type NAME    只压单一 source_type（缺省则分层全 9 类）
 *   --no-count     跳过 countDocsByType 全量计数（用已知 511,962 均分外推，较粗）
 */
import {
  ERB_SOURCE_TYPES,
  countDocsByType,
  readDocContent,
  sampleSingleType,
  stratifiedSample,
  type ErbDoc,
  type ErbSourceType,
} from './lib/erb-loader.js';
import {
  getAdaptiveChunkingProfile,
  parentChildSplit,
} from '../../src/fundamentals/vector-store/text-splitter.js';
import {
  buildChildChunkMeta,
  chunkHash,
  makeParentId,
} from './lib/erb-metadata.js';

// ==================== CLI 解析 ====================

interface CliOptions {
  perType: number;
  seed: number;
  type?: ErbSourceType;
  useRealCount: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { perType: 200, seed: 42, useRealCount: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--per-type') opts.perType = Number(argv[++i]) || 200;
    else if (a === '--seed') opts.seed = Number(argv[++i]) ?? 42;
    else if (a === '--type') {
      const t = argv[++i] as ErbSourceType;
      if (!ERB_SOURCE_TYPES.includes(t)) {
        throw new Error(`--type 非法：${t}，可选 ${ERB_SOURCE_TYPES.join('/')}`);
      }
      opts.type = t;
    } else if (a === '--no-count') opts.useRealCount = false;
  }
  return opts;
}

// ==================== 统计结构 ====================

interface TypeStats {
  sampled: number;
  parents: number;
  children: number;
  origChars: number;
  childChars: number;
  emptyDocs: number;
  profileHist: Map<string, number>;
}

function newStats(): TypeStats {
  return {
    sampled: 0,
    parents: 0,
    children: 0,
    origChars: 0,
    childChars: 0,
    emptyDocs: 0,
    profileHist: new Map(),
  };
}

/** ERB 全量文档数（实测，D:\ragatest 递归遍历去重前） */
const TOTAL_DOCS_KNOWN = 511_962;

// ==================== 单篇切分（镜像生产） ====================

/**
 * 对单篇文档跑生产切分链路，累加统计。
 * 返回本篇子块数（供 smoke 用）。
 */
async function measureDoc(doc: ErbDoc, stats: TypeStats): Promise<number> {
  const text = readDocContent(doc);
  stats.sampled++;
  stats.origChars += text.length;
  if (text.trim().length === 0) {
    stats.emptyDocs++;
    return 0;
  }

  // 🔴 生产同款：先按 .txt + content 取自适应 profile，再 parent-child 切分
  const profile = getAdaptiveChunkingProfile({ fileType: '.txt', content: text });
  stats.profileHist.set(
    profile.documentType,
    (stats.profileHist.get(profile.documentType) ?? 0) + 1,
  );

  const chunks = await parentChildSplit(text, {
    ...profile,
    fileType: '.txt',
  });

  let childCount = 0;
  for (const c of chunks) {
    stats.parents++;
    for (const ch of c.children) {
      stats.children++;
      stats.childChars += ch.text.length;
      childCount++;
    }
  }
  return childCount;
}

// ==================== smoke 验证 erb-metadata ====================

let smokeOk = true;
function smokeAssert(name: string, cond: boolean, detail = ''): void {
  const tag = cond ? '✅' : '❌';
  if (!cond) smokeOk = false;
  console.log(`  ${tag} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 用真实文档验证 erb-metadata 的字段完整性与 chunk_hash 一致性 */
async function smokeMetadata(doc: ErbDoc): Promise<void> {
  console.log('\n[smoke] S1.3 erb-metadata.ts 验证');
  const text = readDocContent(doc);
  const profile = getAdaptiveChunkingProfile({ fileType: '.txt', content: text });
  const chunks = await parentChildSplit(text, { ...profile, fileType: '.txt' });
  const firstChild = chunks[0]?.children[0];
  if (!firstChild) {
    smokeAssert('文档可切出子块', false, '空文档，跳过');
    return;
  }
  const parentId = makeParentId(doc.documentId, 0);
  const firstParent = chunks[0].parent.text;
  const meta = buildChildChunkMeta(doc, firstChild.text, 0, parentId, firstParent);

  smokeAssert('documentId 保留 dsid_ 前缀', meta.documentId.startsWith('dsid_'), meta.documentId);
  smokeAssert('source 为文件名', meta.source.length > 0, meta.source);
  smokeAssert('source_type 合法', ERB_SOURCE_TYPES.includes(meta.source_type), meta.source_type);
  smokeAssert('chunk_role 恒为 child', meta.chunk_role === 'child');
  smokeAssert('parent_id 格式', meta.parent_id === `${doc.documentId}__parent_0`, meta.parent_id);
  smokeAssert(
    'chunk_hash = SHA-256(子块原文)',
    meta.chunk_hash === chunkHash(firstChild.text) && meta.chunk_hash.length === 64,
    meta.chunk_hash.slice(0, 16) + '…',
  );
  smokeAssert(
    'parent_content = 父块全文（供检索展开）',
    meta.parent_content === firstParent && meta.parent_content.length >= firstChild.text.length,
    `len=${meta.parent_content.length}`,
  );
}

// ==================== 主流程 ====================

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.log('=== ERB 膨胀比压测（生产切分镜像）===');
  console.log(
    `抽样：${opts.type ? `单类 ${opts.type}` : '分层全 9 类'}，每类 ${opts.perType} 篇，seed=${opts.seed}`,
  );

  // 1) 抽样
  const samples = new Map<ErbSourceType, ErbDoc[]>();
  if (opts.type) {
    samples.set(opts.type, sampleSingleType(opts.type, opts.perType, opts.seed));
  } else {
    const strat = stratifiedSample(opts.perType, opts.seed);
    for (const [t, docs] of strat) samples.set(t, docs);
  }

  // 2) smoke（用第一个非空文档）
  const smokeDoc = [...samples.values()].flat().find((d) => {
    try {
      return readDocContent(d).trim().length > 0;
    } catch {
      return false;
    }
  });
  if (smokeDoc) await smokeMetadata(smokeDoc);

  // 3) 真实 per-type 文档数（外推用）
  let realCounts: Map<ErbSourceType, number>;
  if (opts.useRealCount) {
    console.log('\n[count] 全量递归计数各 source_type（约 2s）…');
    realCounts = countDocsByType();
  } else {
    // 均分兜底（较粗）
    realCounts = new Map();
    const per = Math.floor(TOTAL_DOCS_KNOWN / ERB_SOURCE_TYPES.length);
    for (const t of ERB_SOURCE_TYPES) realCounts.set(t, per);
  }

  // 4) 逐类切分统计
  console.log('\n[measure] 切分抽样文档…');
  const perType = new Map<ErbSourceType, TypeStats>();
  let done = 0;
  const totalSampled = [...samples.values()].reduce((s, d) => s + d.length, 0);
  for (const [t, docs] of samples) {
    const stats = newStats();
    for (const doc of docs) {
      await measureDoc(doc, stats);
      done++;
      if (done % 200 === 0) console.log(`  …${done}/${totalSampled}`);
    }
    perType.set(t, stats);
  }

  // 5) 报表
  console.log('\n================ 膨胀比压测结果 ================');
  console.log(
    'source_type'.padEnd(14),
    '抽样'.padStart(6),
    '真实文档'.padStart(10),
    '父/篇'.padStart(7),
    '子/篇'.padStart(7),
    '膨胀比'.padStart(8),
    '外推向量'.padStart(14),
  );

  let sumExtrapolated = 0;
  let sumOrig = 0;
  let sumChild = 0;
  let sumSampled = 0;
  let sumChildren = 0;
  let sumParents = 0;
  const profileTotal = new Map<string, number>();

  for (const t of ERB_SOURCE_TYPES) {
    const s = perType.get(t);
    if (!s || s.sampled === 0) continue;
    const real = realCounts.get(t) ?? 0;
    const avgChildren = s.children / s.sampled;
    const avgParents = s.parents / s.sampled;
    const expansion = s.origChars > 0 ? s.childChars / s.origChars : 0;
    const extrapolated = Math.round(real * avgChildren);
    sumExtrapolated += extrapolated;
    sumOrig += s.origChars;
    sumChild += s.childChars;
    sumSampled += s.sampled;
    sumChildren += s.children;
    sumParents += s.parents;
    for (const [k, v] of s.profileHist) {
      profileTotal.set(k, (profileTotal.get(k) ?? 0) + v);
    }
    console.log(
      t.padEnd(14),
      String(s.sampled).padStart(6),
      fmt(real).padStart(10),
      avgParents.toFixed(2).padStart(7),
      avgChildren.toFixed(2).padStart(7),
      expansion.toFixed(3).padStart(8),
      fmt(extrapolated).padStart(14),
    );
  }

  console.log('------------------------------------------------');
  const overallExpansion = sumOrig > 0 ? sumChild / sumOrig : 0;
  console.log(`抽样总篇数        : ${fmt(sumSampled)}`);
  console.log(`平均每篇父块      : ${(sumParents / sumSampled).toFixed(2)}`);
  console.log(`平均每篇子块(向量): ${(sumChildren / sumSampled).toFixed(2)}`);
  console.log(`整体字符膨胀比    : ${overallExpansion.toFixed(3)}  (子块总字符/原文总字符)`);
  console.log(`空文档数          : ${[...perType.values()].reduce((a, s) => a + s.emptyDocs, 0)}`);
  console.log(`profile 分布      : ${[...profileTotal.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log('================================================');
  console.log(`🔴 外推 ${fmt(TOTAL_DOCS_KNOWN)} 篇总向量数 ≈ ${fmt(sumExtrapolated)}`);
  console.log(`   （仅子块入库；父块不写向量库。此数决定 ChromaDB 容量与嵌入总调用量）`);
  console.log('================================================');

  if (!smokeOk) {
    console.error('\n❌ erb-metadata smoke 未全过，请检查 S1.3');
    process.exitCode = 1;
  } else {
    console.log('\n✅ erb-metadata smoke 全过（S1.3 验证通过）');
  }
}

main().catch((err) => {
  console.error('压测失败：', err);
  process.exitCode = 1;
});
