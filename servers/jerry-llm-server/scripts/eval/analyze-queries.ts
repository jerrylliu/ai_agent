/**
 * 查询模式分析脚本
 *
 * 从 search_feedback 表读取隐式反馈数据，按关键词聚类查询，
 * 识别低满意度查询模式，输出分析报告。
 *
 * 分析维度：
 *   1. 按关键词聚类：提取查询中的关键词，按关键词分组统计满意度
 *   2. 按行为类型分布：统计 regenerate / followup / abandon / positive / negative 比例
 *   3. 低满意度查询：负向信号最多的查询
 *   4. 查询长度分布：短查询 vs 长查询的满意度对比
 *
 * 用法：
 *   pnpm ts-node scripts/eval/analyze-queries.ts
 *   pnpm ts-node scripts/eval/analyze-queries.ts -- --days=30 --userId=default
 *
 * 输出：
 *   - 控制台：分析报告
 *   - 文件：scripts/eval/reports/analysis-{timestamp}.json
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import mysql from 'mysql2/promise';
import { config } from '../../src/fundamentals/config.js';

// ==================== 类型定义 ====================

interface SearchFeedbackRow {
  id: number;
  userId: string;
  sessionId: string;
  query: string;
  retrievedDocIds: string;
  action: string;
  responseTimeMs: number;
  resultCount: number;
  modelId: string | null;
  searchType: string;
  metadata: string | null;
  createdAt: Date;
}

interface QueryCluster {
  keyword: string;
  totalQueries: number;
  uniqueQueries: number;
  negative: number;
  positive: number;
  negativeRate: number;
  sampleQueries: string[];
}

interface AnalysisReport {
  generatedAt: string;
  days: number;
  userId: string;
  totalFeedbacks: number;
  actionDistribution: Record<string, number>;
  overallSatisfactionRate: number;
  queryClusters: QueryCluster[];
  lowSatisfactionQueries: Array<{
    query: string;
    total: number;
    negative: number;
    negativeRate: number;
    actions: Record<string, number>;
  }>;
  queryLengthAnalysis: {
    short: { count: number; negativeRate: number };
    medium: { count: number; negativeRate: number };
    long: { count: number; negativeRate: number };
  };
}

// ==================== 中文关键词提取 ====================

/** 停用词列表 */
const STOP_WORDS = new Set([
  '的', '了', '是', '在', '有', '和', '与', '或', '及', '或',
  '怎么', '如何', '什么', '为什么', '哪里', '哪个', '哪些',
  '可以', '能够', '需要', '应该', '必须',
  '一个', '一些', '这种', '那种', '这个', '那个',
  '请', '帮', '给我', '帮我', '麻烦',
  '请问', '一下', '还是', '不要', '不能',
  '关于', '对于', '通过', '使用', '用',
]);

/**
 * 从中文查询中提取关键词
 *
 * 策略：
 *   1. 按空格、标点分割
 *   2. 提取 2-4 字的中文片段作为关键词
 *   3. 过滤停用词
 */
function extractKeywords(query: string): string[] {
  const cleaned = query
    .replace(/[？?！!。，,.、；;：:（）()\[\]【】「」""''']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const segments = cleaned.split(' ');
  const keywords = new Set<string>();

  for (const seg of segments) {
    if (seg.length < 2) continue;
    if (STOP_WORDS.has(seg)) continue;

    // 提取 2-4 字的中文子串
    if (/[\u4e00-\u9fa5]{2,4}/.test(seg)) {
      // 如果是纯中文且 2-4 字，直接作为关键词
      if (/^[\u4e00-\u9fa5]{2,4}$/.test(seg)) {
        keywords.add(seg);
      } else {
        // 混合文本，提取连续中文片段
        const chineseMatches = seg.match(/[\u4e00-\u9fa5]{2,4}/g);
        if (chineseMatches) {
          for (const m of chineseMatches) {
            if (!STOP_WORDS.has(m)) {
              keywords.add(m);
            }
          }
        }
      }
    }

    // 英文单词（长度 >= 3）
    if (/^[a-zA-Z]{3,}$/.test(seg)) {
      keywords.add(seg.toLowerCase());
    }
  }

  return Array.from(keywords);
}

// ==================== 主流程 ====================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const days = parseInt(parseArg(args, '--days') || '7', 10);
  const userId = parseArg(args, '--userId') || 'default';

  console.log('=== 查询模式分析 ===\n');
  console.log(`统计时间范围: 最近 ${days} 天`);
  console.log(`用户: ${userId}\n`);

  // 1. 连接数据库读取数据
  const pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.username,
    password: config.db.password,
    database: config.db.database,
    connectionLimit: 2,
  });

  const since = new Date();
  since.setDate(since.getDate() - days);

  console.log('正在读取隐式反馈数据...');

  const [rows] = await pool.execute(
    `SELECT id, user_id, session_id, query, retrieved_doc_ids, action,
            response_time_ms, result_count, model_id, search_type, metadata, created_at
     FROM search_feedback
     WHERE user_id = ? AND created_at > ?
     ORDER BY created_at DESC`,
    [userId, since],
  );

  const feedbacks = rows as SearchFeedbackRow[];
  console.log(`共 ${feedbacks.length} 条隐式反馈记录\n`);

  if (feedbacks.length === 0) {
    console.log('没有隐式反馈数据，请先在前端集成隐式反馈上报接口。');
    console.log('接口文档：POST /chat/search-feedback');
    await pool.end();
    return;
  }

  // 2. 行为类型分布
  const actionDistribution: Record<string, number> = {};
  for (const f of feedbacks) {
    actionDistribution[f.action] = (actionDistribution[f.action] || 0) + 1;
  }

  const negativeCount = (actionDistribution.regenerate || 0) +
    (actionDistribution.negative || 0) + (actionDistribution.abandon || 0);
  const positiveCount = (actionDistribution.followup || 0) +
    (actionDistribution.positive || 0);
  const overallSatisfactionRate = positiveCount + negativeCount > 0
    ? Math.round((positiveCount / (positiveCount + negativeCount)) * 100) / 100
    : 0;

  // 3. 按关键词聚类
  const clusterMap = new Map<string, {
    totalQueries: number;
    uniqueQueries: Set<string>;
    negative: number;
    positive: number;
    sampleQueries: string[];
  }>();

  for (const f of feedbacks) {
    const keywords = extractKeywords(f.query);
    const isNegative = f.action === 'regenerate' || f.action === 'negative' || f.action === 'abandon';
    const isPositive = f.action === 'followup' || f.action === 'positive';

    for (const kw of keywords) {
      if (!clusterMap.has(kw)) {
        clusterMap.set(kw, {
          totalQueries: 0,
          uniqueQueries: new Set(),
          negative: 0,
          positive: 0,
          sampleQueries: [],
        });
      }
      const cluster = clusterMap.get(kw)!;
      cluster.totalQueries++;
      cluster.uniqueQueries.add(f.query.trim());
      if (isNegative) cluster.negative++;
      if (isPositive) cluster.positive++;
      if (cluster.sampleQueries.length < 3 && !cluster.sampleQueries.includes(f.query)) {
        cluster.sampleQueries.push(f.query);
      }
    }
  }

  const queryClusters: QueryCluster[] = Array.from(clusterMap.entries())
    .filter(([, c]) => c.totalQueries >= 2)
    .map(([keyword, c]) => ({
      keyword,
      totalQueries: c.totalQueries,
      uniqueQueries: c.uniqueQueries.size,
      negative: c.negative,
      positive: c.positive,
      negativeRate: Math.round((c.negative / c.totalQueries) * 100) / 100,
      sampleQueries: c.sampleQueries,
    }))
    .sort((a, b) => b.negativeRate - a.negativeRate || b.totalQueries - a.totalQueries)
    .slice(0, 30);

  // 4. 低满意度查询（按查询文本分组）
  const queryGroups = new Map<string, {
    query: string;
    total: number;
    negative: number;
    actions: Record<string, number>;
  }>();

  for (const f of feedbacks) {
    const normalized = f.query.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!queryGroups.has(normalized)) {
      queryGroups.set(normalized, {
        query: f.query,
        total: 0,
        negative: 0,
        actions: {},
      });
    }
    const g = queryGroups.get(normalized)!;
    g.total++;
    g.actions[f.action] = (g.actions[f.action] || 0) + 1;
    if (f.action === 'regenerate' || f.action === 'negative' || f.action === 'abandon') {
      g.negative++;
    }
  }

  const lowSatisfactionQueries = Array.from(queryGroups.values())
    .filter((g) => g.total >= 2)
    .map((g) => ({
      query: g.query,
      total: g.total,
      negative: g.negative,
      negativeRate: Math.round((g.negative / g.total) * 100) / 100,
      actions: g.actions,
    }))
    .sort((a, b) => b.negativeRate - a.negativeRate || b.total - a.total)
    .slice(0, 20);

  // 5. 查询长度分析
  const lengthBuckets = {
    short: { count: 0, negative: 0 },   // <= 10 字
    medium: { count: 0, negative: 0 },  // 11-25 字
    long: { count: 0, negative: 0 },    // > 25 字
  };

  for (const f of feedbacks) {
    const len = f.query.length;
    const isNegative = f.action === 'regenerate' || f.action === 'negative' || f.action === 'abandon';
    if (len <= 10) {
      lengthBuckets.short.count++;
      if (isNegative) lengthBuckets.short.negative++;
    } else if (len <= 25) {
      lengthBuckets.medium.count++;
      if (isNegative) lengthBuckets.medium.negative++;
    } else {
      lengthBuckets.long.count++;
      if (isNegative) lengthBuckets.long.negative++;
    }
  }

  const queryLengthAnalysis = {
    short: {
      count: lengthBuckets.short.count,
      negativeRate: lengthBuckets.short.count > 0
        ? Math.round((lengthBuckets.short.negative / lengthBuckets.short.count) * 100) / 100
        : 0,
    },
    medium: {
      count: lengthBuckets.medium.count,
      negativeRate: lengthBuckets.medium.count > 0
        ? Math.round((lengthBuckets.medium.negative / lengthBuckets.medium.count) * 100) / 100
        : 0,
    },
    long: {
      count: lengthBuckets.long.count,
      negativeRate: lengthBuckets.long.count > 0
        ? Math.round((lengthBuckets.long.negative / lengthBuckets.long.count) * 100) / 100
        : 0,
    },
  };

  await pool.end();

  // 6. 生成报告
  const report: AnalysisReport = {
    generatedAt: new Date().toISOString(),
    days,
    userId,
    totalFeedbacks: feedbacks.length,
    actionDistribution,
    overallSatisfactionRate,
    queryClusters,
    lowSatisfactionQueries,
    queryLengthAnalysis,
  };

  // 7. 输出到控制台
  console.log('=== 分析结果 ===\n');

  console.log(`总反馈数: ${report.totalFeedbacks}`);
  console.log(`整体满意度: ${report.overallSatisfactionRate}`);
  console.log('\n行为类型分布:');
  for (const [action, count] of Object.entries(actionDistribution)) {
    console.log(`  ${action}: ${count}`);
  }

  console.log('\n--- 关键词聚类（按负向率排序，Top 15）---\n');
  console.log('  关键词        总数  独立查询  负向率  示例');
  console.log('  ' + '-'.repeat(75));
  for (const c of queryClusters.slice(0, 15)) {
    const sample = c.sampleQueries[0]?.substring(0, 30) || '';
    console.log(
      `  ${c.keyword.padEnd(12)} ${String(c.totalQueries).padStart(4)}  ${String(c.uniqueQueries).padStart(6)}    ${String(c.negativeRate).padStart(4)}   ${sample}`,
    );
  }

  console.log('\n--- 低满意度查询（Top 10）---\n');
  for (const q of lowSatisfactionQueries.slice(0, 10)) {
    console.log(`  [${q.negativeRate}] "${q.query}" (总 ${q.total} 次, 负向 ${q.negative} 次)`);
  }

  console.log('\n--- 查询长度分析 ---\n');
  console.log(`  短查询 (<=10字):  ${queryLengthAnalysis.short.count} 条, 负向率 ${queryLengthAnalysis.short.negativeRate}`);
  console.log(`  中查询 (11-25字): ${queryLengthAnalysis.medium.count} 条, 负向率 ${queryLengthAnalysis.medium.negativeRate}`);
  console.log(`  长查询 (>25字):   ${queryLengthAnalysis.long.count} 条, 负向率 ${queryLengthAnalysis.long.negativeRate}`);

  // 8. 保存报告
  const reportsDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportsDir, `analysis-${timestamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log(`\n分析报告已保存: ${reportPath}`);
}

// ==================== 辅助函数 ====================

function parseArg(args: string[], prefix: string): string | undefined {
  for (const arg of args) {
    if (arg.startsWith(`${prefix}=`)) {
      return arg.substring(prefix.length + 1);
    }
  }
  return undefined;
}

main().catch((err) => {
  console.error('分析失败:', err);
  process.exit(1);
});
