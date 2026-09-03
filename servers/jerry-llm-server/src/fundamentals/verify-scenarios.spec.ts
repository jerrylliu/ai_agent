/**
 * 语义空转防线验证脚本
 *
 * 模拟 FC 循环内的工具调用场景，验证 Layer 1/2 是否正确触发。
 * 运行：npx jest --testPathPatterns "verify-scenarios" --no-coverage
 */

jest.mock('./logger.js', () => ({
  logger: {
    info: (...args: any[]) => console.log('[LOG]', ...args),
    warn: (...args: any[]) => console.log('[WARN]', ...args),
    debug: (...args: any[]) => {}, // 静默 debug
    error: (...args: any[]) => console.log('[ERROR]', ...args),
  },
}));

import { SemanticDedupTracker } from './semantic-dedup';
import { SearchResultDedupTracker } from './search-result-dedup';
import { buildNormalizedCacheKey } from './cache-key-normalizer';
import { evaluateRewriteQuality } from './query-rewriter-fallback';
import type { RewrittenQuery } from './vector-store/query-rewriter';
import { CacheFuzzyMatcher, type CacheSlots } from './cache-fuzzy-matcher';
import { CacheAliasLearner, type ComparableResult } from './cache-alias-learner';

// ==================== 场景 1：Layer 1 语义去重拦截 ====================

describe('【场景 1】Layer 1 - 同一 FC 循环内换措辞查知识库', () => {
  it('应拦截第 2 次相似查询', () => {
    console.log('\n========== 场景 1：Layer 1 语义去重 ==========\n');
    const tracker = new SemanticDedupTracker();

    // 第 1 次迭代：模型调用 search_knowledge_base("项目A 进度")
    const call1 = { query: '项目A 进度' };
    const check1 = tracker.check('session-1', 'search_knowledge_base', call1);
    console.log('第 1 次调用:', call1.query);
    console.log('  → 拦截?', check1.isDuplicate, '| 相似度:', check1.similarity.toFixed(3));
    tracker.record('session-1', 'search_knowledge_base', call1);

    // 第 2 次迭代：模型换措辞再调 search_knowledge_base("项目A 进度报告")
    const call2 = { query: '项目A 进度报告' };
    const check2 = tracker.check('session-1', 'search_knowledge_base', call2);
    console.log('第 2 次调用:', call2.query);
    console.log('  → 拦截?', check2.isDuplicate, '| 相似度:', check2.similarity.toFixed(3));
    console.log('  → 匹配的历史查询:', check2.matchedQuery);

    expect(check1.isDuplicate).toBe(false);
    expect(check2.isDuplicate).toBe(true);
    console.log('\n✅ 验证通过：第 2 次相似查询被 Layer 1 拦截\n');
  });
});

// ==================== 场景 2：Layer 2 检索结果重叠警告 ====================

describe('【场景 2】Layer 2 - 换关键词查到同一批文档', () => {
  it('应检测到高度重叠并警告', () => {
    console.log('\n========== 场景 2：Layer 2 检索结果去重 ==========\n');
    const tracker = new SearchResultDedupTracker();

    // 第 1 次检索：查到 doc1, doc2, doc3
    const results1 = [
      { documentId: 'doc1', content: '项目A 进度报告内容' },
      { documentId: 'doc2', content: '项目A 财务情况内容' },
      { documentId: 'doc3', content: '项目A 人员安排内容' },
    ];
    tracker.record('session-1', '项目A 进度', results1);
    console.log('第 1 次检索:', '项目A 进度');
    console.log('  → 返回文档:', results1.map(r => r.documentId).join(', '));

    // 第 2 次检索：换关键词，查到 doc1, doc2（与第 1 次重叠）
    const results2 = [
      { documentId: 'doc1', content: '项目A 进度报告内容' },
      { documentId: 'doc2', content: '项目A 财务情况内容' },
      { documentId: 'doc4', content: '项目A 风险评估内容' },
    ];
    const overlap = tracker.check('session-1', '项目A 最新进展', results2);
    console.log('第 2 次检索:', '项目A 最新进展');
    console.log('  → 返回文档:', results2.map(r => r.documentId).join(', '));
    console.log('  → 重叠率:', (overlap.overlapRate * 100).toFixed(0) + '%');
    console.log('  → 重叠文档数:', overlap.overlapCount);
    console.log('  → 高度重叠?', overlap.isHighOverlap);
    console.log('  → 匹配的历史查询:', overlap.matchedQuery);

    if (overlap.isHighOverlap) {
      console.log('  → 追加警告到 ToolMessage:');
      console.log('    【检索去重提示】你上一轮已检索到 ' + overlap.overlapCount + ' 篇相同文档...');
    }

    expect(overlap.isHighOverlap).toBe(true);
    console.log('\n✅ 验证通过：Layer 2 检测到高度重叠，追加警告\n');
  });
});

// ==================== 场景 3：缓存 key 归一化 ====================

describe('【场景 3】缓存 key 归一化 - 不同措辞生成相同 key', () => {
  it('语序不同应生成相同缓存 key', () => {
    console.log('\n========== 场景 3：缓存 key 归一化 ==========\n');

    const key1 = buildNormalizedCacheKey('项目A 进度');
    const key2 = buildNormalizedCacheKey('进度 项目A');
    const key3 = buildNormalizedCacheKey('项目A，进度！');
    const key4 = buildNormalizedCacheKey('项目A 的 进度');

    console.log('查询 1: "项目A 进度"     → key:', key1);
    console.log('查询 2: "进度 项目A"     → key:', key2);
    console.log('查询 3: "项目A，进度！"  → key:', key3);
    console.log('查询 4: "项目A 的 进度"  → key:', key4);
    console.log('  → key1 == key2?', key1 === key2);
    console.log('  → key1 == key3?', key1 === key3);
    console.log('  → key1 == key4?', key1 === key4);

    expect(key1).toBe(key2);
    expect(key1).toBe(key3);
    expect(key1).toBe(key4);
    console.log('\n✅ 验证通过：不同措辞生成相同缓存 key，可命中缓存\n');
  });
});

// ==================== 场景 3b：keywords 作 cache key 源（修复 mainQuery 不稳定问题）====================

describe('【场景 3b】keywords 作 cache key 源 - 修复改写后 mainQuery 不稳定', () => {
  it('改写后 mainQuery 含不同英文同义词时，keywords 仍生成相同 cache key', () => {
    console.log('\n========== 场景 3b：keywords 作 cache key 源 ==========\n');

    // 模拟 LLM 改写同一查询时，mainQuery 含不同随机英文同义词
    // 但 keywords（核心实体提取）保持稳定
    const rewrite1: RewrittenQuery = {
      mainQuery: '干员 液氮 技能 ability skill',
      subQueries: [],
      keywords: ['干员', '液氮', '技能'],
      wasRewritten: true,
    };
    const rewrite2: RewrittenQuery = {
      mainQuery: '干员 液氮 技能 skill power',
      subQueries: [],
      keywords: ['干员', '液氮', '技能'],
      wasRewritten: true,
    };
    const rewrite3: RewrittenQuery = {
      mainQuery: '干员 液氮 技能 talent capability',
      subQueries: [],
      keywords: ['干员', '液氮', '技能'],
      wasRewritten: true,
    };

    // 旧方案：用 mainQuery 作 cache key 源 → 每次不同
    const oldKey1 = buildNormalizedCacheKey(rewrite1.mainQuery);
    const oldKey2 = buildNormalizedCacheKey(rewrite2.mainQuery);
    const oldKey3 = buildNormalizedCacheKey(rewrite3.mainQuery);
    console.log('旧方案（mainQuery 作 cache key 源）:');
    console.log('  改写1: "' + rewrite1.mainQuery + '" → key:', oldKey1);
    console.log('  改写2: "' + rewrite2.mainQuery + '" → key:', oldKey2);
    console.log('  改写3: "' + rewrite3.mainQuery + '" → key:', oldKey3);
    console.log('  → key1 == key2?', oldKey1 === oldKey2, '（不同英文词导致 key 不同）');

    // 新方案：用 keywords 作 cache key 源 → 稳定相同
    const newKey1 = buildNormalizedCacheKey(rewrite1.keywords.join(' '));
    const newKey2 = buildNormalizedCacheKey(rewrite2.keywords.join(' '));
    const newKey3 = buildNormalizedCacheKey(rewrite3.keywords.join(' '));
    console.log('\n新方案（keywords 作 cache key 源）:');
    console.log('  keywords1:', JSON.stringify(rewrite1.keywords), '→ key:', newKey1);
    console.log('  keywords2:', JSON.stringify(rewrite2.keywords), '→ key:', newKey2);
    console.log('  keywords3:', JSON.stringify(rewrite3.keywords), '→ key:', newKey3);
    console.log('  → key1 == key2?', newKey1 === newKey2);
    console.log('  → key1 == key3?', newKey1 === newKey3);

    expect(oldKey1).not.toBe(oldKey2); // 旧方案不命中
    expect(newKey1).toBe(newKey2);     // 新方案命中
    expect(newKey1).toBe(newKey3);     // 新方案命中
    console.log('\n✅ 验证通过：keywords 作 cache key 源，相同语义不同改写结果命中同一缓存\n');
  });
});

// ==================== 场景 4：改写偏差兜底 ====================

describe('【场景 4】改写偏差兜底 - 偏差大时降级', () => {
  it('改写偏差大应不使用改写后查询', () => {
    console.log('\n========== 场景 4：改写偏差兜底 ==========\n');

    // 改写合理的情况
    const goodRewrite: RewrittenQuery = {
      mainQuery: '项目A 当前进度情况',
      subQueries: [],
      keywords: [],
      wasRewritten: true,
    };
    const goodResult = evaluateRewriteQuality('项目A 进度', goodRewrite);
    console.log('改写合理:');
    console.log('  输入: "项目A 进度" → 改写: "' + goodRewrite.mainQuery + '"');
    console.log('  相似度:', goodResult.similarity?.toFixed(3));
    console.log('  使用改写后查询?', goodResult.useRewritten);

    // 改写偏差大的情况
    const badRewrite: RewrittenQuery = {
      mainQuery: 'Q2 季度财务报告',
      subQueries: [],
      keywords: [],
      wasRewritten: true,
    };
    const badResult = evaluateRewriteQuality('项目A 进度', badRewrite);
    console.log('\n改写偏差大:');
    console.log('  输入: "项目A 进度" → 改写: "' + badRewrite.mainQuery + '"');
    console.log('  相似度:', badResult.similarity?.toFixed(3));
    console.log('  使用改写后查询?', badResult.useRewritten);
    console.log('  降级原因:', badResult.fallbackReason);
    console.log('  → cache key 回退到原始查询: "项目A 进度"');

    expect(goodResult.useRewritten).toBe(true);
    expect(badResult.useRewritten).toBe(false);
    expect(badResult.fallbackReason).toBe('semantic_deviation');
    console.log('\n✅ 验证通过：偏差大时降级用原始查询\n');
  });
});

// ==================== 场景 5：Level 2 缓存模糊匹配 ====================

describe('【场景 5】Level 2 - 缓存模糊匹配（Jaccard + 槽位兼容性）', () => {
  it('不同 keywords 但语义相近时，应模糊匹配到已有缓存', () => {
    console.log('\n========== 场景 5：Level 2 缓存模糊匹配 ==========\n');
    const matcher = new CacheFuzzyMatcher();

    // 第 1 次查询：keywords=["干员","液氮","技能"]，cacheKey="key_001"
    const slots: CacheSlots = { vectorWeight: 0.7, bm25Weight: 0.3, type: 'hybrid' };
    matcher.record('session-1', 'key_001', ['干员', '液氮', '技能'], slots);
    console.log('第 1 次查询（建立索引）:');
    console.log('  keywords: ["干员","液氮","技能"] → cacheKey: key_001');

    // 第 2 次查询：keywords=["干员","液氮","技能介绍"]，Level 1 miss 后走 Level 2
    const match = matcher.findFuzzyMatch('session-1', ['干员', '液氮', '技能介绍'], slots);
    console.log('\n第 2 次查询（模糊匹配）:');
    console.log('  keywords: ["干员","液氮","技能介绍"]');
    console.log('  → 匹配?', match.matched);
    console.log('  → 相似度:', match.similarity.toFixed(3));
    console.log('  → 匹配的 cacheKey:', match.cacheKey);
    console.log('  → 匹配的历史 keywords:', match.matchedKeywords);

    expect(match.matched).toBe(true);
    expect(match.cacheKey).toBe('key_001');
    console.log('\n✅ 验证通过：Level 2 模糊匹配命中已有缓存\n');
  });

  it('槽位不兼容时不应匹配（防止误伤不同意图）', () => {
    console.log('\n========== 场景 5b：槽位兼容性检查 ==========\n');
    const matcher = new CacheFuzzyMatcher();

    // 第 1 次查询：weight=0.7/0.3
    const slots1: CacheSlots = { vectorWeight: 0.7, bm25Weight: 0.3, type: 'hybrid' };
    matcher.record('session-1', 'key_001', ['干员', '液氮', '技能'], slots1);

    // 第 2 次查询：weight=0.5/0.5（不同权重，结果排序不同，不能复用）
    const slots2: CacheSlots = { vectorWeight: 0.5, bm25Weight: 0.5, type: 'hybrid' };
    const match = matcher.findFuzzyMatch('session-1', ['干员', '液氮', '技能'], slots2);
    console.log('不同权重:');
    console.log('  缓存 slots: vectorWeight=0.7, bm25Weight=0.3');
    console.log('  查询 slots: vectorWeight=0.5, bm25Weight=0.5');
    console.log('  → 匹配?', match.matched, '（槽位不兼容，不匹配）');

    expect(match.matched).toBe(false);
    console.log('\n✅ 验证通过：槽位不兼容时不匹配，防止误伤\n');
  });
});

// ==================== 场景 6：Level 3 Alias 自学习 ====================

describe('【场景 6】Level 3 - Alias 自学习（行为验证）', () => {
  it('多次 Level 2 命中同一 targetKey 后，alias 应稳定', () => {
    console.log('\n========== 场景 6：Level 3 Alias 自学习 ==========\n');
    const learner = new CacheAliasLearner();

    // 第 1 次 Level 2 命中：keyA → keyB，置信度=1（未稳定，CONFIDENCE_THRESHOLD=2）
    const stable1 = learner.recordAliasHit('keyA', 'keyB');
    console.log('第 1 次 Level 2 命中:');
    console.log('  keyA → keyB, 置信度=1, 稳定?', stable1);

    // 此时 resolve(keyA) 返回 keyA（alias 未稳定）
    const resolved1 = learner.resolve('keyA');
    console.log('  resolve(keyA):', resolved1, '(未稳定，返回原 key)');

    // 第 2 次 Level 2 命中：keyA → keyB，置信度=2（稳定！）
    const stable2 = learner.recordAliasHit('keyA', 'keyB');
    console.log('\n第 2 次 Level 2 命中:');
    console.log('  keyA → keyB, 置信度=2, 稳定?', stable2);

    // 此时 resolve(keyA) 返回 keyB（alias 已稳定，走 Level 1 直接命中）
    const resolved2 = learner.resolve('keyA');
    console.log('  resolve(keyA):', resolved2, '(已稳定，返回 targetKey)');

    expect(stable1).toBe(false);
    expect(resolved1).toBe('keyA');
    expect(stable2).toBe(true);
    expect(resolved2).toBe('keyB');
    console.log('\n✅ 验证通过：alias 稳定后 resolve 直接返回 targetKey，走 Level 1\n');
  });
});

// ==================== 场景 7：Level 3 结果验证（verifyAndLearn）====================

describe('【场景 7】Level 3 - 结果验证（verifyAndLearn）', () => {
  it('结果重叠率高时应建立 alias', () => {
    console.log('\n========== 场景 7：Level 3 结果验证 ==========\n');
    const learner = new CacheAliasLearner();

    // 缓存结果（3 个文档）
    const cachedResults: ComparableResult[] = [
      { documentId: 'doc1', content: '液氮技能介绍内容A' },
      { documentId: 'doc2', content: '液氮技能介绍内容B' },
      { documentId: 'doc3', content: '液氮技能介绍内容C' },
    ];

    // 实际检索结果（3 个文档，2 个与缓存重叠）
    const actualResults: ComparableResult[] = [
      { documentId: 'doc1', content: '液氮技能介绍内容A' },
      { documentId: 'doc2', content: '液氮技能介绍内容B' },
      { documentId: 'doc4', content: '液氮技能介绍内容D' },
    ];

    const result = learner.verifyAndLearn('keyA', 'keyB', actualResults, cachedResults);
    console.log('结果验证:');
    console.log('  缓存结果: doc1, doc2, doc3');
    console.log('  实际结果: doc1, doc2, doc4');
    console.log('  重叠率:', result.overlapRate.toFixed(3), '(2/3=0.667)');
    console.log('  通过?', result.passed, '(阈值 0.7，未通过)');

    // 重叠率 2/3 = 0.667 < 0.7，未通过
    expect(result.passed).toBe(false);

    // 再试一次：实际结果完全在缓存结果中
    const actualResults2: ComparableResult[] = [
      { documentId: 'doc1', content: '液氮技能介绍内容A' },
      { documentId: 'doc2', content: '液氮技能介绍内容B' },
      { documentId: 'doc3', content: '液氮技能介绍内容C' },
    ];
    const result2 = learner.verifyAndLearn('keyC', 'keyD', actualResults2, cachedResults);
    console.log('\n完全重叠:');
    console.log('  缓存结果: doc1, doc2, doc3');
    console.log('  实际结果: doc1, doc2, doc3');
    console.log('  重叠率:', result2.overlapRate.toFixed(3), '(3/3=1.0)');
    console.log('  通过?', result2.passed, '(阈值 0.7，通过)');
    console.log('  alias 创建?', result2.aliasCreated);
    console.log('  alias 稳定?', result2.aliasStable);

    expect(result2.passed).toBe(true);
    expect(result2.aliasCreated).toBe(true);
    console.log('\n✅ 验证通过：结果重叠率高时建立 alias\n');
  });
});
