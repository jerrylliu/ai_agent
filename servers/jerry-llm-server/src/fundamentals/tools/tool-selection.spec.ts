/**
 * 动态工具选择（selectToolsByQuery）单元测试
 *
 * 背景生产案例 2026-10-12 15:35：复合任务（天气→图表→PDF→推送）在
 * Top-K 截断 + Agent 白名单的双重作用下，模型只看到 2 个工具，
 * 如实报告"工具未挂载"导致任务无法执行。本套件守护修复后的选择规则：
 * 1. 复合任务（≥2 个强意图工具 或 ≥3 个关键词命中工具）必须返回全量
 * 2. 单一强意图工具保底进入结果（不被通用词挤出 Top-K）
 * 3. 工具数不超过阈值时不裁剪
 * 4. 空 query 回落核心工具
 */

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { selectToolsByQuery } from './tool-selection';

/**
 * 参与评分的工具名：前 5 个为真实工具（在 TOOL_SEMANTIC_DESCRIPTIONS 中有
 * 语义描述），其余为无描述的填充名——填充名 fallback 描述是工具名本身，
 * 中文 query 下得分约为 0，仅用于撑过"工具数 > 15"的动态选择激活阈值。
 */
const NAMES = [
  'get_weather',
  'generate_chart',
  'generate_document',
  'send_notification',
  'search_web',
  ...Array.from({ length: 15 }, (_, i) => `filler_tool_${i + 1}`),
];

describe('动态工具选择 selectToolsByQuery', () => {
  it('工具数 ≤ 阈值时直接返回全量（不裁剪）', () => {
    const r = selectToolsByQuery('随便聊聊', NAMES.slice(0, 10));
    expect(r).toEqual(NAMES.slice(0, 10));
  });

  it('复合任务（≥2 个强意图工具命中）应返回全量', () => {
    // "画图表" 命中 generate_chart 的 !!画图；"生成PDF" 命中 generate_document
    // 的 !!生成PDF；"推送" 命中 send_notification 的 !!推送 → 强意图 ≥2
    const r = selectToolsByQuery('查重庆天气画图表并生成PDF最后推送到邮箱', NAMES);
    expect(r).toEqual(NAMES);
  });

  it('复合任务（用户真实问法，≥3 个工具命中普通关键词）应返回全量（生产案例回归）', () => {
    // 生产日志原文 goal：跨域词稀疏，强意图只有"推送"一个，
    // 但 get_weather(天气)/generate_chart(图表)/generate_document(PDF)/
    // send_notification(推送,邮件)/search_web(新闻) 共 5 个工具命中关键词 ≥3
    const r = selectToolsByQuery(
      '重庆天气图表 + 国外新闻PDF → 邮件与飞书推送',
      NAMES,
    );
    expect(r).toEqual(NAMES);
  });

  it('单一强意图：保底该工具进入结果，但仍按 Top-K 裁剪', () => {
    // "查天气" 精确命中 get_weather 的 !!查天气（+10），其余工具得分低
    const r = selectToolsByQuery('查天气', NAMES);
    expect(r).toContain('get_weather');
    expect(r.length).toBeLessThan(NAMES.length);
    expect(r.length).toBeLessThanOrEqual(9); // Top-K(8) + 强意图保底
  });

  it('Top-K 裁剪结果中应包含所有关键词命中的真实工具（不被填充名挤出）', () => {
    // 单一领域问法：只有 get_weather 命中（天气 +3，无 !! 词）
    const r = selectToolsByQuery('重庆今天气温多少度', NAMES);
    expect(r).toContain('get_weather');
  });

  it('空 query 且工具超阈值时回落核心工具（不足则取前 Top-K）', () => {
    // NAMES 中没有 search_knowledge_base / calculate → 走 allNames.slice(0, 8)
    const r = selectToolsByQuery('', NAMES);
    expect(r).toHaveLength(8);
  });

  it('空 query 且包含核心工具时只返回核心工具', () => {
    const names = ['search_knowledge_base', 'calculate', ...NAMES.slice(2)];
    const r = selectToolsByQuery('', names);
    expect(r).toEqual(['search_knowledge_base', 'calculate']);
  });
});
