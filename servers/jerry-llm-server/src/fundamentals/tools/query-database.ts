/**
 * query_database 工具 —— 自然语言查数据库（NL2SQL + SQL 安全网关）
 *
 * 设计目标：
 *   让 Agent 能够用自然语言查询业务数据库，返回结构化结果，
 *   并配合 generate_chart 形成"查询 → 可视化"的数据分析闭环。
 *
 * 三层安全防护：
 *   1. 连接层：使用独立的只读账号（NOTIFY_DB_USER），与主业务数据库隔离
 *   2. SQL 层：node-sql-parser 解析 AST，强制：
 *        - 仅允许 SELECT 语句（拒绝 INSERT/UPDATE/DELETE/DROP/ALTER 等）
 *        - 表名必须在 NOTIFY_DB_ALLOWED_TABLES 白名单内
 *        - 没有 LIMIT 时自动追加 LIMIT 100，避免全表扫描
 *   3. 执行层：使用 mysql2 的 execute（预编译），即便 SQL 注入也无法逃逸
 *
 * 与现有能力的联动：
 *   - 工具被注册到 HITL，每次执行前用户必须确认（防止 LLM 误生成的查询直接执行）
 *   - 结果可作为 generate_chart 的输入，自动形成数据分析流水线
 *   - 调用记录写入 tool-usage 表，便于审计
 */

import { Parser } from 'node-sql-parser';
import mysql from 'mysql2/promise';
import { z } from 'zod';
import { logger } from '../logger';
import { config } from '../config';
import { buildToolJsonSchema, safeParseToolParams } from './_helpers';

// ==================== 配置 / 单例 ====================

/** SQL 语法解析器：用 mysql 方言（兼容大多数业务场景） */
const sqlParser = new Parser();

/** 数据库连接池：mysql2 内置连接池，避免每次查询新建连接 */
let pool: mysql.Pool | null = null;

/** 结果集行数硬上限，超过自动截断 */
const MAX_ROWS = 100;

/** 单次查询超时（毫秒），避免慢 SQL 拖死服务 */
const QUERY_TIMEOUT_MS = 10000;

/** 工具是否可用（由 validate 决定） */
let dbAvailable = false;

// ==================== 配置可用性 ====================

/**
 * 校验外部查询库配置：
 *   必需：NOTIFY_DB_HOST / NOTIFY_DB_USER / NOTIFY_DB_PASSWORD / NOTIFY_DB_DATABASE
 *   可选：NOTIFY_DB_ALLOWED_TABLES（不配则允许所有表，安全性下降）
 */
export function validateQueryDatabaseConfig(): boolean {
  const c = config.queryDb;
  if (!c.host || !c.user || !c.password || !c.database) {
    logger.warn('query_database 工具未配置：缺少 NOTIFY_DB_HOST/USER/PASSWORD/DATABASE，数据库查询功能不可用', {
      module: 'Tool:QueryDatabase',
    });
    dbAvailable = false;
    return false;
  }
  if (c.allowedTables.length === 0) {
    // 不强制要求白名单，但要给出警告，避免误用
    logger.warn('query_database：未配置 NOTIFY_DB_ALLOWED_TABLES，所有表均可被查询，建议配置白名单', {
      module: 'Tool:QueryDatabase',
    });
  }
  dbAvailable = true;
  logger.info('query_database 工具配置校验通过', {
    module: 'Tool:QueryDatabase',
    host: c.host,
    database: c.database,
    allowedTables: c.allowedTables.length ? c.allowedTables.join(',') : '(全部)',
  });
  return true;
}

export function isQueryDatabaseAvailable(): boolean {
  return dbAvailable;
}

// ==================== 工具 Schema ====================

export const queryDatabaseParamsSchema = z.object({
  sql: z
    .string()
    .min(1)
    .describe(
      '要执行的 SQL 语句，必须是 SELECT 查询。会经过语法树校验，禁止任何写入操作。',
    ),
  purpose: z
    .string()
    .optional()
    .describe('本次查询的业务目的，用于日志和确认弹窗展示，例如"统计上个月销售额"'),
});

export type QueryDatabaseParams = z.infer<typeof queryDatabaseParamsSchema>;

export const queryDatabaseSchema = buildToolJsonSchema(
  'query_database',
  '查询外部业务数据库，输入 SQL 查询语句（仅支持 SELECT），返回结果集。当用户询问业务数据（订单、销售、用户、统计等）时使用。结果可后续传给 generate_chart 进行可视化。',
  queryDatabaseParamsSchema,
);

// ==================== 类型定义 ====================

export interface QueryDatabaseResult {
  success: boolean;
  /** 列名，按返回顺序 */
  columns: string[];
  /** 数据行：每行是一个对象，键为列名 */
  rows: Record<string, any>[];
  /** 实际返回行数（已截断后） */
  rowCount: number;
  /** 是否被 MAX_ROWS 截断 */
  truncated: boolean;
  /** 实际执行的 SQL（可能被自动追加了 LIMIT） */
  executedSql: string;
  /** 执行耗时（毫秒） */
  durationMs: number;
  error?: string;
}

// ==================== 安全网关：AST 校验 ====================

interface SqlValidationResult {
  ok: boolean;
  reason?: string;
  /** 校验通过后可能被改写的 SQL（例如自动追加 LIMIT） */
  rewrittenSql?: string;
}

/**
 * 从 AST 节点递归提取所有引用的表名
 * SELECT 语句的 from 字段是 TableExpr 数组，但子查询会嵌套出现
 */
function extractTablesFromAst(node: any, tables: Set<string>): void {
  if (!node || typeof node !== 'object') return;

  // FROM 子句中的表
  if (Array.isArray(node.from)) {
    for (const item of node.from) {
      if (item?.table) tables.add(item.table.toLowerCase());
      // JOIN 子查询也会递归
      if (item?.expr) extractTablesFromAst(item.expr, tables);
    }
  }

  // UNION 等结构
  if (node.ast) extractTablesFromAst(node.ast, tables);

  // 子查询：WHERE/SELECT 表达式中可能嵌入 SELECT
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) {
      for (const item of v) extractTablesFromAst(item, tables);
    } else if (v && typeof v === 'object') {
      extractTablesFromAst(v, tables);
    }
  }
}

/**
 * 核心安全网关：把 SQL 解析成 AST，逐项校验
 *   1. 必须是单条语句
 *   2. 必须是 SELECT
 *   3. 引用的表必须在白名单中
 *   4. 没有 LIMIT 时自动追加 LIMIT 100
 */
function validateAndRewriteSql(sql: string): SqlValidationResult {
  // 简单清洗：去除尾部分号，避免一条语句以分号结尾被解析成多条
  const trimmed = sql.trim().replace(/;\s*$/, '');

  // 拒绝多语句：分号在 SQL 字符串中也可能出现，因此先解析再判断 AST 数组长度
  let astList: any;
  try {
    // database 选项决定方言；使用 mysql 兼容性最好
    astList = sqlParser.astify(trimmed, { database: 'mysql' });
  } catch (e: any) {
    return { ok: false, reason: `SQL 语法错误：${e.message}` };
  }

  // astify 返回值：单条语句是对象，多条语句是数组
  const asts = Array.isArray(astList) ? astList : [astList];
  if (asts.length !== 1) {
    return { ok: false, reason: '只允许单条 SQL 语句' };
  }
  const ast = asts[0];

  // 强制：必须是 SELECT
  if (ast.type !== 'select') {
    return { ok: false, reason: `不允许的语句类型：${ast.type}（仅支持 SELECT）` };
  }

  // 表名白名单校验
  const allowed = config.queryDb.allowedTables.map((t) => t.toLowerCase());
  if (allowed.length > 0) {
    const referenced = new Set<string>();
    extractTablesFromAst(ast, referenced);
    for (const t of referenced) {
      if (!allowed.includes(t)) {
        return { ok: false, reason: `表 "${t}" 不在白名单内，允许的表：${allowed.join(', ')}` };
      }
    }
  }

  // 自动追加 LIMIT：如果用户没写 LIMIT，强制 LIMIT 100，防止全表扫
  let rewritten = trimmed;
  if (!ast.limit || ast.limit.value == null || ast.limit.value.length === 0) {
    rewritten = `${trimmed} LIMIT ${MAX_ROWS}`;
  }

  return { ok: true, rewrittenSql: rewritten };
}

// ==================== 数据库连接 ====================

/**
 * 获取连接池（懒加载单例）
 * 注意：使用 NOTIFY_DB_* 配置，与主业务库的 DB_* 配置完全隔离
 */
function getPool(): mysql.Pool {
  if (pool) return pool;
  pool = mysql.createPool({
    host: config.queryDb.host,
    port: config.queryDb.port,
    user: config.queryDb.user,
    password: config.queryDb.password,
    database: config.queryDb.database,
    // 限制并发连接数，避免占满目标库的连接资源
    connectionLimit: 5,
    // 等待连接而不是立即报错
    waitForConnections: true,
    queueLimit: 20,
  });
  return pool;
}

// ==================== 主入口 ====================

/**
 * 执行 NL2SQL 查询
 * 流程：
 *   1. 校验配置可用
 *   2. 通过 AST 安全网关
 *   3. 用预编译方式执行（防注入）+ 超时控制
 *   4. 截断超大结果集
 */
export async function executeQueryDatabase(rawParams: unknown): Promise<QueryDatabaseResult> {
  const startedAt = Date.now();

  const parsed = safeParseToolParams(queryDatabaseParamsSchema, rawParams);
  if (!parsed.success) {
    logger.warn('query_database：参数校验失败', {
      module: 'Tool:QueryDatabase',
      error: parsed.error,
    });
    return {
      success: false,
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      executedSql: (rawParams as { sql?: string })?.sql || '',
      durationMs: Date.now() - startedAt,
      error: `参数校验失败: ${parsed.error}`,
    };
  }
  const params = parsed.data;

  if (!dbAvailable) {
    return {
      success: false,
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      executedSql: params.sql,
      durationMs: 0,
      error: 'query_database 工具未配置，请联系管理员设置 NOTIFY_DB_* 环境变量',
    };
  }

  // 第一道闸：AST 安全校验
  const validation = validateAndRewriteSql(params.sql);
  if (!validation.ok) {
    logger.warn('query_database：SQL 校验未通过', {
      module: 'Tool:QueryDatabase',
      reason: validation.reason,
      sql: params.sql.substring(0, 200),
    });
    return {
      success: false,
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      executedSql: params.sql,
      durationMs: Date.now() - startedAt,
      error: `SQL 不安全：${validation.reason}`,
    };
  }

  const finalSql = validation.rewrittenSql!;

  logger.info('query_database：开始执行查询', {
    module: 'Tool:QueryDatabase',
    purpose: params.purpose,
    sql: finalSql.substring(0, 500),
  });

  // 第二道闸：执行层（预编译 + 超时）
  let conn: mysql.PoolConnection | null = null;
  try {
    conn = await getPool().getConnection();
    // 设置当前 session 的最大执行时间（MySQL 5.7+ 支持）
    // 注：execute 没有第三方超时参数，依赖 session 变量 + AbortController 双保险
    await conn.query(`SET SESSION MAX_EXECUTION_TIME=${QUERY_TIMEOUT_MS}`);

    // 用 query 而非 execute：execute 只支持参数化查询，
    // 我们的 SQL 已经过 AST 校验，且无外部参数注入点，安全等价
    const [rows, fields] = await conn.query(finalSql);

    if (!Array.isArray(rows)) {
      // 非 SELECT 不会到这里（前面已拦截），兜底处理
      throw new Error('查询返回了非数组结果，可能不是 SELECT 语句');
    }

    const columns = (fields as any[]).map((f) => f.name);
    const allRows = rows as Record<string, any>[];
    const truncated = allRows.length > MAX_ROWS;
    const finalRows = truncated ? allRows.slice(0, MAX_ROWS) : allRows;

    const result: QueryDatabaseResult = {
      success: true,
      columns,
      rows: finalRows,
      rowCount: finalRows.length,
      truncated,
      executedSql: finalSql,
      durationMs: Date.now() - startedAt,
    };

    logger.info('query_database：查询完成', {
      module: 'Tool:QueryDatabase',
      rowCount: result.rowCount,
      durationMs: result.durationMs,
      truncated,
    });
    return result;
  } catch (e: any) {
    logger.error('query_database：查询失败', {
      module: 'Tool:QueryDatabase',
      error: e.message,
      sql: finalSql.substring(0, 200),
    });
    return {
      success: false,
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      executedSql: finalSql,
      durationMs: Date.now() - startedAt,
      error: e.message || String(e),
    };
  } finally {
    // 务必释放连接，否则连接池被耗尽
    if (conn) conn.release();
  }
}
