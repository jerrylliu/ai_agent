/**
 * Agent Router - 意图路由器
 *
 * 在 FC 循环开始前，根据用户输入快速判断意图，预先决定：
 * 1. 应启用哪个 Agent（决定 system prompt 和工具子集）
 * 2. 是否直接触发某个 Pipeline 模板（跳过 LLM 自行规划）
 *
 * 设计原则：
 * - 规则优先：用关键词匹配快速判断，避免 LLM Router 的延迟和成本
 * - LLM 兜底：规则无法判断时，回落到默认 Agent（不引入额外 LLM 调用）
 * - 透明降级：路由失败时不阻断主流程，仅在日志中标记
 *
 * 复用现有能力：
 * - selectToolsByQuery：基于关键词匹配工具
 * - TOOL_SEMANTIC_DESCRIPTIONS：现成的工具语义关键词
 */

import { logger } from '../logger';
import { hasPipelineTemplate, listPipelineTemplates } from '../workflow/pipeline-templates';

// ==================== Agent 定义 ====================

/** Agent 的"专长"标识 */
export type AgentRole = 'general' | 'search' | 'analysis' | 'creative' | 'document';

/** Agent 配置 */
export interface AgentConfig {
  role: AgentRole;
  /** Agent 名称 */
  name: string;
  /** Agent 简介 */
  description: string;
  /** Agent 应使用的工具子集（未列出的工具不暴露给该 Agent） */
  toolWhitelist?: string[];
  /** Agent 专属的额外 system prompt（追加到默认 prompt 之后） */
  extraPrompt?: string;
}

/** 路由结果 */
export interface RoutingResult {
  /** 选定的 Agent */
  agent: AgentConfig;
  /** 推荐预先触发的流水线（可选） */
  suggestedWorkflow?: { templateId: string; reason: string };
  /** 路由命中策略（用于调试） */
  matchedBy: 'rule' | 'fallback';
  /** 命中分数（仅 rule 模式有意义） */
  score?: number;
}

// ==================== 预置 Agent ====================

const AGENTS: Record<AgentRole, AgentConfig> = {
  general: {
    role: 'general',
    name: '通用助手',
    description: '处理日常对话、知识问答、闲聊等通用任务',
    // general 不限制工具，享有完整能力（兜底 Agent）
    extraPrompt: '',
  },
  search: {
    role: 'search',
    name: '信息检索专家',
    description: '专注于知识库搜索、联网搜索、网页抓取',
    toolWhitelist: [
      'search_knowledge_base',
      'list_knowledge_base',
      'search_web',
      'crawl_webpage',
      'execute_workflow',
      'create_plan',
      'update_plan_step',
      'get_plan',
    ],
    extraPrompt: '\n\n你当前是信息检索专家，请优先使用搜索类工具帮助用户查找信息。如果用户的需求是一个多步任务（如搜索后整理为图表/思维导图），请先尝试用 execute_workflow 触发预置流水线。',
  },
  analysis: {
    role: 'analysis',
    name: '数据分析师',
    description: '专注于计算、图表生成、数据可视化',
    toolWhitelist: [
      'calculate',
      'generate_chart',
      'search_knowledge_base',
      'list_knowledge_base',
      'execute_workflow',
      'create_plan',
      'update_plan_step',
      'get_plan',
    ],
    extraPrompt: '\n\n你当前是数据分析师，请优先使用计算和图表工具。生成图表时务必调用 generate_chart 而非用文字描述。',
  },
  creative: {
    role: 'creative',
    name: '创意助手',
    description: '专注于图片生成、思维导图、创意表达',
    toolWhitelist: [
      'generate_image',
      'create_mindmap',
      'generate_chart',
      'search_knowledge_base',
      'execute_workflow',
      'create_plan',
      'update_plan_step',
      'get_plan',
    ],
    extraPrompt: '\n\n你当前是创意助手，请优先使用 generate_image / create_mindmap 等可视化工具。生成图片或思维导图时务必调用对应工具，不要仅用文字描述。',
  },
  document: {
    role: 'document',
    name: '文档管理专家',
    description: '专注于文档创建、更新、摘要、对比',
    toolWhitelist: [
      'create_document',
      'update_document',
      'summarize_document',
      'compare_documents',
      'search_knowledge_base',
      'list_knowledge_base',
      'execute_workflow',
      'create_plan',
      'update_plan_step',
      'get_plan',
    ],
    extraPrompt: '\n\n你当前是文档管理专家，请使用文档相关工具帮助用户管理知识库内容。',
  },
};

// ==================== 路由规则 ====================

/**
 * 关键词路由规则。每个 Agent 配一组高置信度关键词。
 * 命中任意一个关键词即得 1 分，分数最高的 Agent 胜出。
 * 平局时按 AGENT_PRIORITY 顺序选择。
 */
const ROUTING_KEYWORDS: Record<AgentRole, string[]> = {
  general: [],
  search: ['搜索', '搜', '查找', '查一下', '查询', '检索', '联网', '资料', '知识库', '文档里', '上传过', '最新', '新闻', '实时', '网页'],
  analysis: ['计算', '算一下', '运算', '图表', '可视化', '柱状图', '折线图', '饼图', '雷达图', '数据', '统计', '分析'],
  creative: ['画', '画图', '画一', '生成图', '生成图片', '文生图', '思维导图', '脑图', '导图'],
  document: ['创建文档', '新建文档', '写一篇', '更新文档', '摘要', '对比文档', '总结文档', '文档版本'],
};

/**
 * 平局裁决优先级（前者优先）
 * 一般来说"具体能力 Agent" > "通用 Agent"
 */
const AGENT_PRIORITY: AgentRole[] = ['creative', 'analysis', 'document', 'search', 'general'];

/**
 * Pipeline 模板触发关键词
 * 命中即提示"建议用此模板"，由 LLM 决定是否真正触发
 */
const PIPELINE_TRIGGERS: Array<{ templateId: string; keywords: string[][] }> = [
  {
    templateId: 'search_kb_and_mindmap',
    // 二维数组：每个内层数组都需要至少命中一个（AND-of-OR）
    keywords: [
      ['知识库', '资料', '文档里', '上传过'], // 知识库相关
      ['思维导图', '脑图', '导图'],
    ],
  },
  {
    templateId: 'web_search_and_mindmap',
    keywords: [
      ['联网', '最新', '实时', '新闻'], // 联网搜索相关
      ['思维导图', '脑图', '导图'],
    ],
  },
  {
    templateId: 'search_kb_and_chart',
    keywords: [
      ['知识库', '资料', '文档里', '上传过'],
      ['图表', '可视化', '柱状', '折线', '饼图', '雷达图', '数据图'],
    ],
  },
  {
    templateId: 'web_search_and_document',
    keywords: [
      ['联网', '最新', '实时', '新闻'],
      ['文档', '整理', '记录', '保存'],
    ],
  },
];

// ==================== 路由实现 ====================

/**
 * 主路由函数：根据用户输入决定使用哪个 Agent
 *
 * @param userInput 用户输入文本
 * @returns 路由结果（包含选定的 Agent 配置）
 */
export function routeRequest(userInput: string | undefined): RoutingResult {
  if (!userInput || userInput.trim().length === 0) {
    return {
      agent: AGENTS.general,
      matchedBy: 'fallback',
    };
  }

  const text = userInput.toLowerCase();

  // 计算每个 Agent 的关键词命中分数
  const scores: Record<AgentRole, number> = {
    general: 0,
    search: 0,
    analysis: 0,
    creative: 0,
    document: 0,
  };

  for (const [role, keywords] of Object.entries(ROUTING_KEYWORDS) as Array<[AgentRole, string[]]>) {
    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) {
        scores[role] += 1;
      }
    }
  }

  // 找出最高分
  let maxScore = 0;
  for (const role of AGENT_PRIORITY) {
    if (scores[role] > maxScore) maxScore = scores[role];
  }

  let selectedRole: AgentRole;
  if (maxScore === 0) {
    selectedRole = 'general';
  } else {
    // 平局按优先级裁决
    selectedRole = AGENT_PRIORITY.find(role => scores[role] === maxScore) || 'general';
  }

  // 检查是否匹配某个 Pipeline 模板
  const suggestedWorkflow = matchPipelineTemplate(text);

  const result: RoutingResult = {
    agent: AGENTS[selectedRole],
    matchedBy: maxScore > 0 ? 'rule' : 'fallback',
    score: maxScore,
    suggestedWorkflow,
  };

  logger.info('Agent Router：路由决策', {
    module: 'AgentRouter',
    userInput: userInput.substring(0, 100),
    selectedAgent: selectedRole,
    matchedBy: result.matchedBy,
    score: maxScore,
    allScores: scores,
    suggestedWorkflow: suggestedWorkflow?.templateId,
  });

  return result;
}

/**
 * 匹配 Pipeline 模板
 * 规则：每组 keywords 数组都需要至少命中一个关键词（AND-of-OR）
 */
function matchPipelineTemplate(text: string): { templateId: string; reason: string } | undefined {
  for (const trigger of PIPELINE_TRIGGERS) {
    const allGroupsMatched = trigger.keywords.every(group =>
      group.some(kw => text.includes(kw.toLowerCase()))
    );
    if (allGroupsMatched && hasPipelineTemplate(trigger.templateId)) {
      const matchedKws = trigger.keywords
        .map(group => group.find(kw => text.includes(kw.toLowerCase())))
        .filter(Boolean)
        .join('+');
      return {
        templateId: trigger.templateId,
        reason: `命中关键词组合：${matchedKws}`,
      };
    }
  }
  return undefined;
}

/**
 * 获取所有 Agent 列表（供调试或前端展示）
 */
export function listAgents(): AgentConfig[] {
  return Object.values(AGENTS);
}

/**
 * 根据 role 获取 Agent 配置
 */
export function getAgent(role: AgentRole): AgentConfig {
  return AGENTS[role];
}

/**
 * 应用 Agent 的工具白名单：从 schemas 中过滤出该 Agent 可用的子集
 * 当 Agent 未配置 toolWhitelist 时返回原列表（不过滤）
 */
export function applyAgentToolWhitelist(schemas: any[], agent: AgentConfig): any[] {
  if (!agent.toolWhitelist || agent.toolWhitelist.length === 0) {
    return schemas;
  }
  const whitelistSet = new Set(agent.toolWhitelist);
  const filtered = schemas.filter(s => whitelistSet.has(s?.function?.name));
  logger.info('Agent Router：已应用工具白名单', {
    module: 'AgentRouter',
    agentRole: agent.role,
    originalCount: schemas.length,
    filteredCount: filtered.length,
    filteredTools: filtered.map(s => s?.function?.name).join(', '),
  });
  return filtered;
}
