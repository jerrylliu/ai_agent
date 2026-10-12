/**
 * 动态工具选择（按 query 语义相关性筛选本轮绑定给模型的工具）
 *
 * 独立成模块的原因（生产案例 2026-10-12 15:35）：原逻辑放在 tools/index.ts
 * 的 barrel 里，拖带 40+ 重依赖（数据库/Redis/LLM 客户端），单元测试一 import
 * 就崩溃，导致这段"决定模型能看到哪些工具"的关键逻辑长期零测试覆盖，最终以
 * "模型声称工具未挂载"的生产事故暴露。抽出后仅依赖 logger，可独立单测。
 *
 * 设计原则：动态选择只做 token 经济性优化，不做工具可用性裁决——
 * 存在性由注册门控（isXxxAvailable）负责，裁剪底线由模型能力协商负责，
 * 本模块在任何情况下不允许"饿死"任务必需的跨域工具（复合任务返回全量）。
 */

import { logger } from '../logger';

// ==================== 语义描述表 ====================

/**
 * 工具语义描述，用于关键词匹配检索
 * 当工具数量超过 TOOL_RETRIEVAL_THRESHOLD 时，根据用户 query 匹配最相关的工具
 *
 * 格式约定：
 *   - 普通关键词：用空格分隔（每命中 +3 分）
 *   - 强意图词（动词短语等高判别力词）：用"!!"前缀（命中 +10 分）
 *     用于让"发邮件/发消息/查数据库"等明确意图压过"内容/文件"等通用名词
 *
 * 注意：新增工具时必须在此表登记，否则 fallback 用工具名本身做描述，
 * 中文 query 下得分约为 0，等于对动态选择隐身（generate_document 曾漏登，
 * 复合任务里它永远进不了 Top-K——生产案例 2026-10-12 的推手之一）
 */
export const TOOL_SEMANTIC_DESCRIPTIONS: Record<string, string> = {
  search_knowledge_base: '搜索 知识库 文档 上传 文件 查找 资料',
  list_knowledge_base: '列出 概览 清单 有什么 包含 哪些 文档列表 知识库内容',
  search_web:
    '!!联网搜索 !!最新新闻 !!实时信息 联网 搜索 网页 互联网 最新 新闻 实时 在线 查询',
  get_weather:
    '!!查天气 !!天气预报 天气 气温 温度 下雨 晴天 阴天 湿度 风力 空气质量 预报',
  calculate: '!!计算 !!算一下 数学 运算 算术 公式 三角函数 对数 开方 乘除',
  manage_session:
    '!!新建会话 !!删除会话 !!切换会话 会话 对话 新建 删除 重命名 置顶 切换 管理',
  create_plan: '规划 计划 步骤 任务 分步 执行 复杂 多步骤',
  update_plan_step: '更新 步骤 状态 完成 失败 跳过',
  get_plan: '查看 计划 进度 回顾 状态',
  crawl_webpage: '!!抓取网页 !!读取网页 抓取 网页 全文 深度 阅读 读取 页面',
  create_document: '!!创建文档 !!新建文档 创建 新建 文档 笔记 记录 写入 保存',
  update_document: '!!更新文档 !!修改文档 更新 修改 编辑 文档 版本 变更',
  summarize_document: '!!生成摘要 !!总结文档 摘要 总结 概括 文档 核心 要点',
  compare_documents: '!!对比文档 !!比较文档 对比 比较 差异 不同 文档 区别',
  list_documents: '!!列文档 !!文档清单 文档列表 无标签 标签筛选 找文档 文档ID',
  update_document_meta: '!!改标签 !!打标签 加标签 标签 改标题 文档描述',
  delete_document: '!!删除文档 删文档 删除 移除 文档',
  list_document_versions: '!!版本列表 !!历史版本 版本 历史',
  restore_document_version: '!!恢复版本 !!回退版本 恢复 回退 还原',
  // ---------------- 知识源管理工具（第 2 批） ----------------
  list_knowledge_sources:
    '!!知识源 !!爬取源 !!网站源 知识源 爬取源 同步状态 清单 列表 订阅源',
  add_knowledge_source:
    '!!添加知识源 !!添加爬取源 !!订阅网站 !!新增知识源 添加 新增 知识源 爬取 网站 订阅',
  delete_knowledge_source: '!!删除知识源 !!删爬取源 删除 移除 知识源 爬取源',
  sync_knowledge_source:
    '!!同步知识源 !!同步 !!重新爬取 同步 更新 知识源 爬取 抓取 刷新',
  get_knowledge_status:
    '!!知识库状态 知识库 统计 健康状况 向量库 索引进度 多少文档 片段数',
  rebuild_knowledge_index:
    '!!重建索引 !!重建向量 !!全量重建 重建 索引 向量 全量 重嵌入 修复检索',
  // ---------------- 设置域 / 评估 / 收藏工具（第 3 批） ----------------
  get_system_status:
    '!!系统状态 !!当前模型 !!什么模型 设置 状态 Key配置 功能开关 开着吗 用哪个模型',
  switch_model:
    '!!切换模型 !!换模型 !!换个模型 切换 换 模型 改用 换个大模型 用某某模型',
  toggle_feature:
    '!!打开记忆 !!关闭记忆 !!打开摘要 !!关闭摘要 !!开关功能 记忆 摘要 开启 关闭 功能开关 MinerU 解析',
  query_evaluation_stats:
    '!!评估统计 !!回答质量 质量 评估 点赞 点踩 满意度 编造 判分 忠实率 相关率',
  list_favorite_documents:
    '!!收藏夹 !!看收藏 收藏 清单 列表 生成文档 收藏的文档',
  toggle_document_favorite:
    '!!收藏 !!取消收藏 收藏 取消收藏 收藏夹 生成文档',
  generate_chart:
    '!!画图 !!生成图表 !!可视化 图表 折线图 柱状图 饼图 数据可视化 绘图',
  generate_image: '!!画图 !!生成图片 !!文生图 图片 画图 生成图 图像 绘画',
  create_mindmap: '!!思维导图 !!脑图 思维导图 脑图 知识结构 逻辑关系 梳理',
  generate_document:
    '!!生成文档 !!生成PDF !!导出PDF 文档 PDF 报告 导出 简报 生成',
  execute_workflow:
    '!!执行工作流 !!运行流水线 工作流 流水线 流程 一键 自动化 组合 多步 模板',
  // ---------------- 外部 API 集成工具：意图词重点加权 ----------------
  send_notification:
    '!!发邮件 !!发消息 !!发送邮件 !!发送消息 !!发飞书 !!发钉钉 !!发通知 !!推送 !!提醒我 !!告诉 !!通知 通知 提醒 飞书 邮件 邮箱 钉钉 webhook 推送 告诉 发消息 发邮件 发送',
  query_database:
    '!!查数据库 !!查表 !!查询数据 !!统计销售 !!统计订单 !!查订单 !!查用户 数据库 查询 SQL 业务数据 统计 订单 销售 用户 表',
  mcp_proxy:
    '!!调用MCP !!使用MCP !!MCP工具 MCP GitHub 文件系统 Slack Notion 外部工具 生态 扩展',
};

/** 动态工具选择阈值，工具数超过此值才启用 */
export const TOOL_RETRIEVAL_THRESHOLD = 15;

/** 动态选择返回的最大工具数 */
export const TOOL_RETRIEVAL_TOP_K = 8;

// ==================== 选择算法 ====================

/**
 * 基于用户 query 动态选择最相关的工具
 * 使用关键词匹配评分，工具数 <= TOOL_RETRIEVAL_THRESHOLD 时直接返回全量
 *
 * @param query 用户输入的查询文本
 * @param allNames 参与评分的工具名列表（由调用方传入，通常来自注册表）
 * @returns 选出的工具名称列表
 */
export function selectToolsByQuery(
  query: string,
  allNames: string[],
): string[] {
  // 工具数未超过阈值，不需要动态选择
  if (allNames.length <= TOOL_RETRIEVAL_THRESHOLD) {
    return allNames;
  }

  if (!query || query.trim().length === 0) {
    // 无 query 时返回核心工具
    const coreTools = allNames.filter((name) =>
      ['search_knowledge_base', 'calculate'].includes(name),
    );
    return coreTools.length > 0
      ? coreTools
      : allNames.slice(0, TOOL_RETRIEVAL_TOP_K);
  }

  const queryLower = query.toLowerCase();
  const queryChars = new Set(queryLower.split(''));

  // 计算每个工具与 query 的相关性分数
  const scored = allNames.map((name) => {
    const desc = TOOL_SEMANTIC_DESCRIPTIONS[name] || name;
    const descLower = desc.toLowerCase();
    let score = 0;

    // 关键词匹配：区分"强意图词"（!! 前缀，权重 10）和"普通词"（权重 3）
    // 这样"发邮件/查数据库"等明确意图能压过"内容/文件"等通用名词
    const keywords = descLower.split(/\s+/);
    for (const kw of keywords) {
      if (!kw) continue;
      if (kw.startsWith('!!')) {
        const intent = kw.slice(2);
        if (intent && queryLower.includes(intent)) {
          score += 10; // 强意图词命中：极高权重
        }
      } else if (queryLower.includes(kw)) {
        score += 3; // 普通词命中
      }
    }

    // 字符级重叠度（处理中文无空格的情况）
    let charOverlap = 0;
    for (const char of queryChars) {
      if (descLower.includes(char) && /[\u4e00-\u9fff]/.test(char)) {
        charOverlap++;
      }
    }
    score += charOverlap * 0.5;

    // 工具名匹配
    if (queryLower.includes(name.toLowerCase())) {
      score += 5;
    }

    return { name, score };
  });

  // 按分数降序排列
  scored.sort((a, b) => b.score - a.score);

  // 强意图工具：命中"!!"前缀词（分数 ≥ 10），代表用户明确说出了动作意图
  const strongIntent = scored.filter((s) => s.score >= 10);
  // 关键词命中工具：至少命中一个普通关键词（分数 ≥ 3，过滤纯字符重叠噪声）
  const keywordHit = scored.filter((s) => s.score >= 3);

  // 复合任务检测（生产案例 2026-10-12 15:35）：跨域任务（如"重庆天气图表 +
  // 国外新闻PDF → 邮件与飞书推送"）会同时命中 get_weather/generate_chart/
  // generate_document/send_notification 等多个领域的工具，Top-K 截断会饿死
  // 任务必需的跨域工具。此时返回全量——工具可见性由注册门控 + 模型裁剪层
  // 守住底线，动态选择只做 token 经济性优化，不允许以牺牲任务完整性为代价。
  // 两个信号：≥2 个强意图工具命中，或 ≥3 个工具命中普通关键词（覆盖真实
  // 问法里强意图词稀疏的情况，如只出现"推送"一个 !! 词）
  if (strongIntent.length >= 2 || keywordHit.length >= 3) {
    logger.info('动态工具选择：复合任务命中，返回全量工具', {
      module: 'ToolRegistry',
      query: query.substring(0, 100),
      totalTools: allNames.length,
      strongIntentTools: strongIntent.map((s) => s.name).join(', '),
      keywordHitTools: keywordHit.map((s) => s.name).join(', '),
    });
    return allNames;
  }

  // 单一/无强意图：Top-K 之外保底带上强意图工具，防止明确意图被通用词挤出前 8
  const selectedSet = new Set(
    scored.slice(0, TOOL_RETRIEVAL_TOP_K).map((s) => s.name),
  );
  for (const s of strongIntent) selectedSet.add(s.name);
  const selected = [...selectedSet];

  logger.info('动态工具选择', {
    module: 'ToolRegistry',
    query: query.substring(0, 100),
    totalTools: allNames.length,
    selectedTools: selected.join(', '),
    topScores: scored
      .slice(0, TOOL_RETRIEVAL_TOP_K)
      .map((s) => `${s.name}(${s.score.toFixed(1)})`)
      .join(', '),
  });

  return selected;
}
