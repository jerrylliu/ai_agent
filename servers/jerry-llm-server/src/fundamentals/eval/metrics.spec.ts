/**
 * 检索评估指标计算单测
 *
 * 覆盖：
 *   - Recall@K / Precision@K / MRR / NDCG@K 的边界和典型场景
 *   - evaluateQuery 组合指标
 *   - aggregateResults 分组聚合
 */
import {
  recallAtK,
  precisionAtK,
  reciprocalRank,
  ndcgAtK,
  evaluateQuery,
  aggregateResults,
  type SingleQueryEval,
} from './metrics';

describe('检索评估指标', () => {
  // ==================== Recall@K ====================
  describe('recallAtK', () => {
    it('全部命中 → 1.0', () => {
      expect(recallAtK(['d1', 'd2', 'd3'], ['d1', 'd2', 'd3'], 3)).toBe(1);
    });

    it('部分命中 → 命中数 / 期望数', () => {
      // 期望 3 个，top3 只命中 2 个
      expect(recallAtK(['d1', 'd2', 'd4'], ['d1', 'd2', 'd3'], 3)).toBeCloseTo(
        2 / 3,
        4,
      );
    });

    it('无命中 → 0', () => {
      expect(recallAtK(['d4', 'd5'], ['d1', 'd2'], 5)).toBe(0);
    });

    it('K 小于期望数，部分命中', () => {
      // 期望 4 个，K=2 只命中 1 个（d5 不在期望列表）→ 1/4
      expect(recallAtK(['d1', 'd5'], ['d1', 'd2', 'd3', 'd4'], 2)).toBe(0.25);
    });

    it('期望列表为空 → 0（避免除零）', () => {
      expect(recallAtK(['d1', 'd2'], [], 3)).toBe(0);
    });

    it('检索结果为空 → 0', () => {
      expect(recallAtK([], ['d1', 'd2'], 3)).toBe(0);
    });

    it('K 大于检索结果长度，只算实际命中', () => {
      // 检索 2 条，K=5，命中 1 条 → 1/3
      expect(recallAtK(['d1', 'd4'], ['d1', 'd2', 'd3'], 5)).toBeCloseTo(
        1 / 3,
        4,
      );
    });

    it('重复 docId 只算一次（去重）', () => {
      expect(recallAtK(['d1', 'd1', 'd2'], ['d1', 'd2'], 3)).toBe(1);
    });
  });

  // ==================== Precision@K ====================
  describe('precisionAtK', () => {
    it('全部命中 → 1.0', () => {
      expect(precisionAtK(['d1', 'd2', 'd3'], ['d1', 'd2', 'd3'], 3)).toBe(1);
    });

    it('部分命中 → 命中数 / K', () => {
      // top3 中 2 条命中 → 2/3
      expect(precisionAtK(['d1', 'd2', 'd4'], ['d1', 'd2', 'd3'], 3)).toBeCloseTo(
        2 / 3,
        4,
      );
    });

    it('无命中 → 0', () => {
      expect(precisionAtK(['d4', 'd5'], ['d1', 'd2'], 2)).toBe(0);
    });

    it('K=0 → 0', () => {
      expect(precisionAtK(['d1'], ['d1'], 0)).toBe(0);
    });

    it('检索结果少于 K，按实际数量计算', () => {
      // 检索 2 条，K=5，命中 1 条 → 1/5（Precision@K 固定除以 K）
      expect(precisionAtK(['d1', 'd4'], ['d1', 'd2'], 5)).toBeCloseTo(1 / 5, 4);
    });

    it('期望列表为空 → 0', () => {
      expect(precisionAtK(['d1', 'd2'], [], 2)).toBe(0);
    });
  });

  // ==================== Reciprocal Rank (MRR) ====================
  describe('reciprocalRank', () => {
    it('第 1 位命中 → 1.0', () => {
      expect(reciprocalRank(['d1', 'd2', 'd3'], ['d1'])).toBe(1);
    });

    it('第 2 位命中 → 0.5', () => {
      expect(reciprocalRank(['d4', 'd1', 'd3'], ['d1'])).toBe(0.5);
    });

    it('第 3 位命中 → 1/3', () => {
      expect(reciprocalRank(['d4', 'd5', 'd1'], ['d1'])).toBeCloseTo(1 / 3, 4);
    });

    it('无命中 → 0', () => {
      expect(reciprocalRank(['d4', 'd5'], ['d1', 'd2'])).toBe(0);
    });

    it('期望列表为空 → 0', () => {
      expect(reciprocalRank(['d1', 'd2'], [])).toBe(0);
    });

    it('检索结果为空 → 0', () => {
      expect(reciprocalRank([], ['d1'])).toBe(0);
    });

    it('多个期望文档，取第一个命中的排名', () => {
      // d2 排第 2，d3 排第 3 → 取 d2 的排名 → 0.5
      expect(reciprocalRank(['d1', 'd2', 'd3'], ['d2', 'd3'])).toBe(0.5);
    });
  });

  // ==================== NDCG@K ====================
  describe('ndcgAtK', () => {
    it('理想排序（所有相关文档排最前）→ 1.0', () => {
      expect(ndcgAtK(['d1', 'd2', 'd3'], ['d1', 'd2', 'd3'], 3)).toBe(1);
    });

    it('无命中 → 0', () => {
      expect(ndcgAtK(['d4', 'd5'], ['d1', 'd2'], 2)).toBe(0);
    });

    it('期望列表为空 → 0', () => {
      expect(ndcgAtK(['d1', 'd2'], [], 2)).toBe(0);
    });

    it('K=0 → 0', () => {
      expect(ndcgAtK(['d1'], ['d1'], 0)).toBe(0);
    });

    it('相关文档排后面 → NDCG < 1', () => {
      // d1 排第 3 → DCG = 1/log2(4) ≈ 0.5
      // IDCG = 1/log2(2) = 1.0
      // NDCG ≈ 0.5
      const result = ndcgAtK(['d4', 'd5', 'd1'], ['d1'], 3);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(1);
      expect(result).toBeCloseTo(1 / Math.log2(4), 4);
    });

    it('K 大于检索结果，按实际结果计算 DCG', () => {
      // 检索 2 条，d1 命中 → DCG = 1/log2(2) = 1
      // IDCG = 1/log2(2) = 1
      // NDCG = 1.0
      expect(ndcgAtK(['d1', 'd4'], ['d1'], 5)).toBe(1);
    });

    it('多个相关文档，部分命中 → 0 < NDCG < 1', () => {
      // 期望 [d1, d2, d3]，检索 [d1, d4, d2]
      // DCG = 1/log2(2) + 1/log2(4) = 1 + 0.5 = 1.5
      // IDCG = 1/log2(2) + 1/log2(3) + 1/log2(4) = 1 + 0.6309 + 0.5 = 2.1309
      // NDCG ≈ 0.704
      const result = ndcgAtK(['d1', 'd4', 'd2'], ['d1', 'd2', 'd3'], 3);
      expect(result).toBeGreaterThan(0.5);
      expect(result).toBeLessThan(1);
    });

    it('二元相关性：重复 docId 不重复累计 DCG', () => {
      // d1 出现两次，只算第一次
      const result = ndcgAtK(['d1', 'd1', 'd2'], ['d1'], 3);
      expect(result).toBe(1); // d1 排第一 → NDCG = 1
    });
  });

  // ==================== evaluateQuery ====================
  describe('evaluateQuery', () => {
    it('返回所有 K 值的指标 + MRR', () => {
      const metrics = evaluateQuery(
        ['d1', 'd2', 'd3', 'd4'],
        ['d1', 'd3'],
        [1, 3, 5],
      );

      expect(metrics).toHaveProperty('Recall@1');
      expect(metrics).toHaveProperty('Recall@3');
      expect(metrics).toHaveProperty('Recall@5');
      expect(metrics).toHaveProperty('Precision@1');
      expect(metrics).toHaveProperty('Precision@3');
      expect(metrics).toHaveProperty('Precision@5');
      expect(metrics).toHaveProperty('NDCG@1');
      expect(metrics).toHaveProperty('NDCG@3');
      expect(metrics).toHaveProperty('NDCG@5');
      expect(metrics).toHaveProperty('MRR');
    });

    it('第 1 位命中 → Recall@1 = 0.5（2 个期望，命中 1 个）', () => {
      const metrics = evaluateQuery(['d1', 'd2'], ['d1', 'd3'], [1]);
      expect(metrics['Recall@1']).toBe(0.5);
      expect(metrics['Precision@1']).toBe(1);
      expect(metrics['MRR']).toBe(1);
    });

    it('所有指标保留 4 位小数', () => {
      const metrics = evaluateQuery(['d2', 'd1'], ['d1'], [1]);
      // Recall@1 = 0 (d2 不是期望), 精确到 4 位
      expect(metrics['Recall@1']).toBe(0);
      // MRR = 1/2 = 0.5
      expect(metrics['MRR']).toBe(0.5);
    });
  });

  // ==================== aggregateResults ====================
  describe('aggregateResults', () => {
    function makeResult(
      sampleId: string,
      metrics: Record<string, number>,
      category = 'entity',
      difficulty = 'easy',
      hasError = false,
    ): SingleQueryEval {
      return {
        sampleId,
        query: `query-${sampleId}`,
        retrievedDocIds: [],
        expectedDocIds: [],
        metrics,
        category,
        difficulty,
        error: hasError ? 'search failed' : undefined,
      };
    }

    it('计算所有样本各指标的均值', () => {
      const perQuery: SingleQueryEval[] = [
        makeResult('q1', { 'Recall@3': 1.0, MRR: 1.0 }),
        makeResult('q2', { 'Recall@3': 0.5, MRR: 0.5 }),
      ];

      const report = aggregateResults(perQuery, {
        topK: 3,
        kValues: [3],
        searchType: 'hybrid',
      });

      expect(report.totalSamples).toBe(2);
      expect(report.evaluatedSamples).toBe(2);
      expect(report.errorSamples).toBe(0);
      expect(report.aggregate['Recall@3']).toBe(0.75);
      expect(report.aggregate['MRR']).toBe(0.75);
    });

    it('排除出错样本', () => {
      const perQuery: SingleQueryEval[] = [
        makeResult('q1', { 'Recall@3': 1.0 }),
        makeResult('q2', { 'Recall@3': 0.0 }, 'entity', 'easy', true),
      ];

      const report = aggregateResults(perQuery, {
        topK: 3,
        kValues: [3],
        searchType: 'hybrid',
      });

      expect(report.totalSamples).toBe(2);
      expect(report.evaluatedSamples).toBe(1);
      expect(report.errorSamples).toBe(1);
      expect(report.aggregate['Recall@3']).toBe(1.0);
    });

    it('按 category 分组统计', () => {
      const perQuery: SingleQueryEval[] = [
        makeResult('q1', { 'Recall@3': 1.0 }, 'entity'),
        makeResult('q2', { 'Recall@3': 0.5 }, 'entity'),
        makeResult('q3', { 'Recall@3': 0.0 }, 'semantic'),
      ];

      const report = aggregateResults(perQuery, {
        topK: 3,
        kValues: [3],
        searchType: 'hybrid',
      });

      expect(report.byCategory['entity']['Recall@3']).toBe(0.75);
      expect(report.byCategory['semantic']['Recall@3']).toBe(0);
    });

    it('按 difficulty 分组统计', () => {
      const perQuery: SingleQueryEval[] = [
        makeResult('q1', { 'Recall@3': 1.0 }, 'entity', 'easy'),
        makeResult('q2', { 'Recall@3': 0.2 }, 'entity', 'hard'),
      ];

      const report = aggregateResults(perQuery, {
        topK: 3,
        kValues: [3],
        searchType: 'hybrid',
      });

      expect(report.byDifficulty['easy']['Recall@3']).toBe(1.0);
      expect(report.byDifficulty['hard']['Recall@3']).toBe(0.2);
    });

    it('空结果集 → 空聚合', () => {
      const report = aggregateResults([], {
        topK: 3,
        kValues: [3],
        searchType: 'hybrid',
      });

      expect(report.totalSamples).toBe(0);
      expect(report.aggregate).toEqual({});
    });

    it('包含时间戳和参数', () => {
      const report = aggregateResults([], {
        topK: 5,
        kValues: [1, 3, 5],
        searchType: 'vector',
      });

      expect(report.timestamp).toBeTruthy();
      expect(report.params.topK).toBe(5);
      expect(report.params.kValues).toEqual([1, 3, 5]);
      expect(report.params.searchType).toBe('vector');
    });
  });
});
