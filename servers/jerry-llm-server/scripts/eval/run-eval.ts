/**
 * 检索召回评估脚本（离线评估集入口）
 *
 * 加载 dataset.json → 对每条样本执行检索 → 计算 Recall@K / Precision@K / MRR / NDCG → 输出报告
 *
 * 用法：
 *   pnpm ts-node scripts/eval/run-eval.ts
 *   pnpm ts-node scripts/eval/run-eval.ts -- --topK=10 --searchType=hybrid
 *   pnpm ts-node scripts/eval/run-eval.ts -- --searchType=vector  # 纯向量检索
 *
 * 输出：
 *   - 控制台：汇总指标表格
 *   - 文件：scripts/eval/reports/report-{timestamp}.json（含每条查询详细结果）
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { hybridSearchKnowledgeBase, searchKnowledgeBase } from '../../src/fundamentals/vector-store/index.js';
import {
  evaluateQuery,
  aggregateResults,
  type EvalSample,
  type SingleQueryEval,
  type EvalReport,
} from '../../src/fundamentals/eval/metrics.js';

// ==================== 主流程 ====================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const topK = parseInt(parseArg(args, '--topK') || '10', 10);
  const searchType = parseArg(args, '--searchType') || 'hybrid';
  const kValues = [1, 3, 5, 10];
  const datasetPath = parseArg(args, '--dataset') || path.join(__dirname, 'dataset.json');

  console.log('=== 检索召回离线评估 ===\n');
  console.log(`数据集: ${datasetPath}`);
  console.log(`检索方式: ${searchType}`);
  console.log(`topK: ${topK}`);
  console.log(`K 值: ${kValues.join(', ')}\n`);

  // 1. 加载数据集
  if (!fs.existsSync(datasetPath)) {
    console.error(`数据集文件不存在: ${datasetPath}`);
    console.error('请先运行 pnpm ts-node scripts/eval/generate-dataset.ts 生成数据集');
    process.exit(1);
  }

  const datasetRaw = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
  const samples: EvalSample[] = datasetRaw.samples || [];
  console.log(`数据集样本数: ${samples.length}\n`);

  if (samples.length === 0) {
    console.error('数据集为空，无法评估。');
    process.exit(1);
  }

  // 2. 逐条执行检索评估
  const perQuery: SingleQueryEval[] = [];

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    process.stdout.write(`  [${i + 1}/${samples.length}] ${sample.id}: "${sample.query.substring(0, 40)}..." → `);

    try {
      const startTime = Date.now();

      // 执行检索
      let results: Array<{ content: string; metadata: any; score: number }>;
      if (searchType === 'vector') {
        results = await searchKnowledgeBase(sample.query, topK);
      } else {
        const hybridResults = await hybridSearchKnowledgeBase(sample.query, topK);
        results = hybridResults.map((r) => ({
          content: r.content,
          metadata: r.metadata,
          score: r.score,
        }));
      }

      const durationMs = Date.now() - startTime;

      // 从检索结果中提取 docId
      const retrievedDocIds = results.map((r) =>
        String(r.metadata?.documentId || r.metadata?.doc_id || ''),
      ).filter((id) => id !== '');

      // 计算指标
      const metrics = evaluateQuery(retrievedDocIds, sample.expectedDocIds, kValues);

      const evalResult: SingleQueryEval = {
        sampleId: sample.id,
        query: sample.query,
        retrievedDocIds,
        expectedDocIds: sample.expectedDocIds,
        metrics,
        durationMs,
        category: sample.category,
        difficulty: sample.difficulty,
      };

      perQuery.push(evalResult);

      // 输出简要结果
      const recallAt5 = metrics['Recall@5'] ?? 0;
      const mrr = metrics['MRR'] ?? 0;
      const hits = retrievedDocIds.filter((id) => sample.expectedDocIds.includes(id)).length;
      process.stdout.write(
        `命中 ${hits}/${sample.expectedDocIds.length} | Recall@5=${recallAt5} | MRR=${mrr} | ${durationMs}ms\n`,
      );
    } catch (error: any) {
      perQuery.push({
        sampleId: sample.id,
        query: sample.query,
        retrievedDocIds: [],
        expectedDocIds: sample.expectedDocIds,
        metrics: {},
        error: error.message,
        category: sample.category,
        difficulty: sample.difficulty,
      });
      process.stdout.write(`错误: ${error.message}\n`);
    }
  }

  // 3. 聚合结果
  const report: EvalReport = aggregateResults(perQuery, {
    topK,
    kValues,
    searchType,
  });

  // 4. 输出到控制台
  console.log('\n=== 评估结果汇总 ===\n');
  console.log(`总样本: ${report.totalSamples} | 成功: ${report.evaluatedSamples} | 出错: ${report.errorSamples}\n`);

  console.log('整体指标:');
  printMetricsTable(report.aggregate);

  console.log('\n按分类分组:');
  for (const [category, metrics] of Object.entries(report.byCategory)) {
    console.log(`\n  [${category}]`);
    printMetricsTable(metrics, '    ');
  }

  console.log('\n按难度分组:');
  for (const [difficulty, metrics] of Object.entries(report.byDifficulty)) {
    console.log(`\n  [${difficulty}]`);
    printMetricsTable(metrics, '    ');
  }

  // 5. 保存详细报告
  const reportsDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportsDir, `report-${timestamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log(`\n详细报告已保存: ${reportPath}`);
}

// ==================== 辅助函数 ====================

function printMetricsTable(metrics: Record<string, number>, indent = '  '): void {
  const keys = Object.keys(metrics);
  if (keys.length === 0) {
    console.log(`${indent}(无数据)`);
    return;
  }

  // 按指标类型分组打印
  const recallKeys = keys.filter((k) => k.startsWith('Recall@'));
  const precisionKeys = keys.filter((k) => k.startsWith('Precision@'));
  const ndcgKeys = keys.filter((k) => k.startsWith('NDCG@'));
  const mrrKey = keys.find((k) => k === 'MRR');

  if (recallKeys.length > 0) {
    console.log(`${indent}Recall:    ${recallKeys.map((k) => `${k}=${metrics[k]}`).join('  ')}`);
  }
  if (precisionKeys.length > 0) {
    console.log(`${indent}Precision: ${precisionKeys.map((k) => `${k}=${metrics[k]}`).join('  ')}`);
  }
  if (ndcgKeys.length > 0) {
    console.log(`${indent}NDCG:      ${ndcgKeys.map((k) => `${k}=${metrics[k]}`).join('  ')}`);
  }
  if (mrrKey) {
    console.log(`${indent}MRR:       ${mrrKey}=${metrics[mrrKey]}`);
  }
}

function parseArg(args: string[], prefix: string): string | undefined {
  for (const arg of args) {
    if (arg.startsWith(`${prefix}=`)) {
      return arg.substring(prefix.length + 1);
    }
  }
  return undefined;
}

main().catch((err) => {
  console.error('评估失败:', err);
  process.exit(1);
});
