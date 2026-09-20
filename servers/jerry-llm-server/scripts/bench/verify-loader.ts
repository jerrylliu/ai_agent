/**
 * erb-loader 验证脚本（用真实数据端到端证明正确性）
 *
 * 运行：pnpm --filter jerry-llm-server bench:verify-loader
 * 或：  node --import ./scripts/ts-loader.mjs --experimental-transform-types scripts/bench/verify-loader.ts
 *
 * 校验项：
 *   1. 文件名解析：extractDocumentId / extractSlug / isValidDocumentId
 *   2. 递归遍历：confluence（嵌套子目录）能正确产出合法 dsid
 *   3. questions.jsonl：500 条、字段完整、空 gold 计数
 *   4. 🔴 交叉验证：gold expected_doc_ids 能在对应 source_type 遍历结果中命中
 *      （这是 dsid 铁律的端到端证明——对不上则 Document Recall 恒为 0）
 *   5. toEvalSamples 字段映射
 *   6. 抽样：蓄水池抽样确定性 + 单类/分层抽样数量正确
 *   7. readDocContent 能读到非空正文
 *   8. gold-first 逆向抽样（方案 §3.0.1）：gold 闭包 722、T0/T1-mini 数量与
 *      确定性、干扰不与 gold 重叠（需多次全库遍历，约 1 分钟）
 *
 * 传 --full 时执行「全量交叉验证」：遍历 51 万文档，确认 500 题所有 gold 均命中。
 */
import {
  ERB_SOURCE_TYPES,
  extractDocumentId,
  extractSlug,
  isValidDocumentId,
  walkDocs,
  readDocContent,
  loadQuestions,
  toEvalSamples,
  sampleSingleType,
  stratifiedSample,
  goldFirstSample,
  getGoldDocIdSet,
  type ErbSourceType,
} from './lib/erb-loader.js';

// ==================== 极简断言框架 ====================

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

// ==================== 1. 文件名解析 ====================

function testFilenameParsing(): void {
  section('1. 文件名解析（dsid 铁律）');
  const fn =
    'dsid_00019f542a8240739395dde5fec41708__company-atelier-classroom-ai.txt';
  const id = extractDocumentId(fn);
  check(
    'extractDocumentId 保留 dsid_ 前缀',
    id === 'dsid_00019f542a8240739395dde5fec41708',
    `实际=${id}`,
  );
  check('isValidDocumentId 认合法 dsid', isValidDocumentId(id));
  check(
    'extractSlug 去 .txt 且不被内部 __ 截断',
    extractSlug(fn) === 'company-atelier-classroom-ai',
    `实际=${extractSlug(fn)}`,
  );
  // 含完整路径也应正确（内部取 basename）
  check(
    'extractDocumentId 支持完整路径',
    extractDocumentId(`D:\\ragatest\\hubspot\\${fn}`) === id,
  );
  // slug 内含 __ 的边界情况
  check(
    'extractSlug 处理 slug 内部含 __',
    extractSlug('dsid_aabbccddeeff00112233445566778899__foo__bar.txt') ===
      'foo__bar',
  );
  check('isValidDocumentId 拒绝去前缀的 id', !isValidDocumentId('00019f54'));
}

// ==================== 2. 递归遍历（嵌套目录） ====================

function testRecursiveWalk(): void {
  section('2. 递归遍历（confluence 嵌套子目录）');
  const docs = Array.from(walkDocs({ sourceType: 'confluence', limit: 20 }));
  check('confluence 能产出文档', docs.length === 20, `实际=${docs.length}`);
  const allValid = docs.every((d) => isValidDocumentId(d.documentId));
  check('产出的 documentId 全部合法', allValid);
  const allNestedOk = docs.every((d) => d.sourceType === 'confluence');
  check('sourceType 标注正确', allNestedOk);
  // confluence 是嵌套结构，确认确实读到了子目录里的文件（路径含多级）
  const hasNested = docs.some(
    (d) => d.filePath.split(/[\\/]/).length > 4,
  );
  check('确实递归进入嵌套子目录', hasNested, docs[0]?.filePath);
  console.log(`     样例路径: ${docs[0]?.filePath}`);
}

// ==================== 3. questions.jsonl ====================

function testQuestions(): void {
  section('3. questions.jsonl 加载');
  const questions = loadQuestions();
  check('共 500 条', questions.length === 500, `实际=${questions.length}`);
  const fieldsOk = questions.every(
    (q) =>
      typeof q.question_id === 'string' &&
      typeof q.question === 'string' &&
      Array.isArray(q.expected_doc_ids) &&
      Array.isArray(q.source_types),
  );
  check('字段完整', fieldsOk);
  const emptyGold = questions.filter((q) => q.expected_doc_ids.length === 0);
  console.log(`     空 gold 题数=${emptyGold.length}（预期 30：high_level 10 + info_not_found 20）`);
  const types = new Set(questions.map((q) => q.question_type));
  console.log(`     question_type 取值: ${[...types].join(', ')}`);
  // gold 的 dsid 格式抽查
  const goldSample = questions.find((q) => q.expected_doc_ids.length > 0);
  check(
    'gold expected_doc_ids 为合法 dsid 格式',
    !!goldSample && goldSample.expected_doc_ids.every(isValidDocumentId),
    goldSample?.expected_doc_ids.join(','),
  );
}

// ==================== 4. 交叉验证（dsid 端到端） ====================

/**
 * 针对指定 source_type 子集做交叉验证：
 * 遍历这些类型建 documentId 集合，检查「source_types 完全落在该子集内」的题目
 * 的 gold 是否都能命中。
 */
function crossValidate(subset: ErbSourceType[], label: string): void {
  const subsetSet = new Set<string>(subset);
  const docIds = new Set<string>();
  for (const t of subset) {
    for (const d of walkDocs({ sourceType: t })) docIds.add(d.documentId);
  }
  const questions = loadQuestions().filter(
    (q) =>
      q.expected_doc_ids.length > 0 &&
      q.source_types.length > 0 &&
      q.source_types.every((s) => subsetSet.has(s)),
  );
  let hit = 0;
  let miss = 0;
  const missExamples: string[] = [];
  for (const q of questions) {
    const allHit = q.expected_doc_ids.every((id) => docIds.has(id));
    if (allHit) hit++;
    else {
      miss++;
      if (missExamples.length < 3) {
        const missing = q.expected_doc_ids.filter((id) => !docIds.has(id));
        missExamples.push(`${q.question_id}: 缺 ${missing.join(',')}`);
      }
    }
  }
  console.log(
    `     [${label}] 文档池=${docIds.size}，可验证题=${questions.length}，全命中=${hit}，有缺失=${miss}`,
  );
  if (missExamples.length) console.log(`     缺失样例: ${missExamples.join(' | ')}`);
  check(
    `[${label}] gold 全部命中（dsid 端到端对齐）`,
    questions.length > 0 && miss === 0,
  );
}

function testCrossValidation(): void {
  section('4. 交叉验证：gold expected_doc_ids ↔ 遍历 documentId');
  // 选小体量类型，遍历快；confluence 同时证明嵌套目录也能命中
  crossValidate(['github', 'confluence', 'jira'], 'github+confluence+jira');
}

function testFullCrossValidation(): void {
  section('4b. 全量交叉验证（遍历 51 万文档，较慢）');
  const t0 = Date.now();
  const docIds = new Set<string>();
  for (const d of walkDocs()) docIds.add(d.documentId);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`     全量文档池=${docIds.size}，耗时=${elapsed}s`);
  check('全量文档数 ≈ 511,962', docIds.size >= 511000, `实际=${docIds.size}`);
  const questions = loadQuestions().filter((q) => q.expected_doc_ids.length > 0);
  let miss = 0;
  const missExamples: string[] = [];
  for (const q of questions) {
    const missing = q.expected_doc_ids.filter((id) => !docIds.has(id));
    if (missing.length) {
      miss++;
      if (missExamples.length < 5) missExamples.push(`${q.question_id}: 缺 ${missing.join(',')}`);
    }
  }
  if (missExamples.length) console.log(`     缺失样例: ${missExamples.join(' | ')}`);
  check(
    `全部 ${questions.length} 道非空 gold 题均命中`,
    miss === 0,
    `缺失题数=${miss}`,
  );
}

// ==================== 5. toEvalSamples 映射 ====================

function testEvalSampleMapping(): void {
  section('5. toEvalSamples 字段映射');
  const questions = loadQuestions();
  const samples = toEvalSamples(questions);
  check('数量一致', samples.length === questions.length);
  const q0 = questions[0];
  const s0 = samples[0];
  check('id ← question_id', s0.id === q0.question_id);
  check('query ← question', s0.query === q0.question);
  check(
    'expectedDocIds ← expected_doc_ids',
    JSON.stringify(s0.expectedDocIds) === JSON.stringify(q0.expected_doc_ids),
  );
  check('category ← question_type', s0.category === q0.question_type);
  check('note ← source_types.join', s0.note === q0.source_types.join(','));
}

// ==================== 6. 抽样 ====================

function testSampling(): void {
  section('6. 抽样（蓄水池 + 确定性）');
  const a = sampleSingleType('hubspot', 100, 42);
  const b = sampleSingleType('hubspot', 100, 42);
  check('单类抽样数量正确', a.length === 100, `实际=${a.length}`);
  check(
    '同种子结果可复现',
    a.map((d) => d.documentId).join() === b.map((d) => d.documentId).join(),
  );
  const c = sampleSingleType('hubspot', 100, 7);
  check(
    '不同种子结果不同',
    a.map((d) => d.documentId).join() !== c.map((d) => d.documentId).join(),
  );
  check('抽样结果 documentId 全部合法', a.every((d) => isValidDocumentId(d.documentId)));
  const strat = stratifiedSample(50, 42);
  check('分层抽样覆盖全部 9 类', strat.size === ERB_SOURCE_TYPES.length);
  const allFifty = [...strat.values()].every((v) => v.length === 50);
  check('分层抽样每类 50 篇', allFifty);
}

// ==================== 7. 读正文 ====================

function testReadContent(): void {
  section('7. readDocContent');
  const [doc] = walkDocs({ sourceType: 'hubspot', limit: 1 });
  const content = readDocContent(doc);
  check('正文非空', content.length > 0, `len=${content.length}`);
  check('正文为字符串', typeof content === 'string');
  console.log(`     ${doc.documentId} 正文长度=${content.length}`);
}

// ==================== 8. gold-first 逆向抽样 ====================

function testGoldFirst(): void {
  section('8. gold-first 逆向抽样（方案 §3.0.1）');
  const goldIds = getGoldDocIdSet();
  check('gold 并集 = 722 篇（方案实测值）', goldIds.size === 722, `实际=${goldIds.size}`);

  // T0：gold-only 基准
  const t0a = [...goldFirstSample({ interference: 0 })];
  check('T0 = 722 篇', t0a.length === 722, `实际=${t0a.length}`);
  check('T0 全部命中 gold 集合', t0a.every((d) => goldIds.has(d.documentId)));
  check('T0 documentId 唯一', new Set(t0a.map((d) => d.documentId)).size === t0a.length);
  check('T0 documentId 全部合法', t0a.every((d) => isValidDocumentId(d.documentId)));

  // 确定性：两次生成序列一致
  const t0b = [...goldFirstSample({ interference: 0 })];
  check(
    'T0 两次生成序列一致（确定性）',
    t0a.map((d) => d.documentId).join() === t0b.map((d) => d.documentId).join(),
  );

  // T1-mini：干扰 200（seed=42）——gold 前缀恒定 + 干扰不与 gold 重叠
  const t1mini = [...goldFirstSample({ interference: 200, seed: 42 })];
  check('T1-mini = 922 篇（722 gold + 200 干扰）', t1mini.length === 922, `实际=${t1mini.length}`);
  const goldPrefixOk = t1mini
    .slice(0, 722)
    .map((d) => d.documentId)
    .join() === t0a.map((d) => d.documentId).join();
  check('追加干扰时 gold 前缀恒定', goldPrefixOk);
  check('干扰部分不与 gold 重叠', t1mini.slice(722).every((d) => !goldIds.has(d.documentId)));
  check(
    '干扰部分 documentId 唯一且 = 200',
    new Set(t1mini.slice(722).map((d) => d.documentId)).size === 200,
  );

  // seed 可复现 + 不同 seed 结果不同
  const t1mini2 = [...goldFirstSample({ interference: 200, seed: 42 })];
  check(
    'T1-mini 同 seed 两次生成一致（可复现）',
    t1mini.map((d) => d.documentId).join() === t1mini2.map((d) => d.documentId).join(),
  );
  const t1mini3 = [...goldFirstSample({ interference: 200, seed: 43 })];
  check(
    '不同 seed 干扰序列不同',
    t1mini.map((d) => d.documentId).join() !== t1mini3.map((d) => d.documentId).join(),
  );
}

// ==================== 主流程 ====================

function main(): void {
  console.log('erb-loader 验证开始');
  const full = process.argv.includes('--full');

  testFilenameParsing();
  testRecursiveWalk();
  testQuestions();
  testCrossValidation();
  if (full) testFullCrossValidation();
  testEvalSampleMapping();
  testSampling();
  testReadContent();
  testGoldFirst();

  console.log(`\n========== 结果：通过 ${passed}，失败 ${failed} ==========`);
  if (failed > 0) {
    console.log('❌ 存在失败项，请检查上方输出');
    process.exit(1);
  }
  console.log('✅ 全部通过');
  if (!full) console.log('（提示：加 --full 可执行全量 51 万文档交叉验证）');
}

main();
