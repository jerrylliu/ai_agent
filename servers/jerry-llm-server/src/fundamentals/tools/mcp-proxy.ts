/**
 * mcp_proxy 工具 —— 接入 Anthropic MCP（Model Context Protocol）生态
 *
 * 设计目标：
 *   把任意符合 MCP 协议的 Server（GitHub、Filesystem、Slack、Notion 等）
 *   通过一个统一入口暴露给 Agent，实现"接一次客户端 = 白嫖一整个生态"。
 *
 * 实现方式：
 *   - 启动时根据 NOTIFY_MCP_SERVERS 环境变量初始化所有 MCP Server 客户端
 *     （配置格式：JSON 数组，每个 server 含 name + command + args）
 *   - 通过 stdio transport 与 MCP Server 通信（最常见的 MCP 部署方式）
 *   - 启动后调用 client.listTools() 拉取每个 server 暴露的工具
 *   - 对外暴露一个虚拟工具 mcp_proxy(server, tool, arguments)，
 *     由它路由到具体的 MCP Server.callTool()
 *
 * 安全考量：
 *   - 工具被注册到 HITL，每次调用前用户确认（MCP Server 可能执行写操作）
 *   - MCP Server 进程崩溃不影响主服务，调用失败返回明确错误信息
 *   - 启动初始化失败的 server 自动跳过，不阻塞服务启动
 *
 * 备注：
 *   实际生产可考虑给每个 MCP 工具单独注册一个 schema（更原生）；
 *   本实现采用"单一代理工具 + tool 名作为参数"的方式，规避动态 schema 注册的复杂度，
 *   适合个人项目快速落地。
 */

import { logger } from '../logger';
import { config } from '../config';

// ==================== 类型定义 ====================

/** 单个 MCP Server 配置项（来自 NOTIFY_MCP_SERVERS） */
interface McpServerConfig {
  /** Server 的逻辑名称（Agent 调用时使用） */
  name: string;
  /** 启动命令，例如 "npx" */
  command: string;
  /** 命令参数，例如 ["-y", "@modelcontextprotocol/server-filesystem", "/path"] */
  args: string[];
  /** 可选：传给子进程的环境变量 */
  env?: Record<string, string>;
}

/** MCP Server 运行时状态 */
interface McpServerRuntime {
  config: McpServerConfig;
  /** MCP SDK 的 Client 实例（any 类型避免对未安装包的强依赖） */
  client: any;
  /** 该 server 暴露的工具列表（缓存） */
  tools: Array<{ name: string; description?: string; inputSchema?: any }>;
}

// ==================== 模块状态 ====================

/** 全局运行时表：name -> McpServerRuntime */
const runtimeMap = new Map<string, McpServerRuntime>();

/** 是否完成初始化 */
let initialized = false;

/** MCP 初始化流程是否已完成 */
let initializationCompleted = false;

/** 工具是否可用：至少一个 MCP Server 通过健康检查 */
let mcpAvailable = false;

// ==================== 配置解析 ====================

/**
 * 解析 NOTIFY_MCP_SERVERS 环境变量，必须是合法 JSON 数组
 * 失败时返回空数组，不抛异常（避免启动崩溃）
 */
function parseMcpServersConfig(): McpServerConfig[] {
  const raw = config.notify.mcpServers;
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logger.warn('mcp_proxy：NOTIFY_MCP_SERVERS 必须是数组', { module: 'Tool:McpProxy' });
      return [];
    }
    return parsed.filter((s) => s && s.name && s.command);
  } catch (e: any) {
    logger.error('mcp_proxy：NOTIFY_MCP_SERVERS JSON 解析失败', {
      module: 'Tool:McpProxy',
      error: e.message,
    });
    return [];
  }
}

function updateMcpAvailability(): void {
  mcpAvailable = runtimeMap.size > 0;
}

async function removeRuntime(server: string, reason: string): Promise<void> {
  const runtime = runtimeMap.get(server);
  if (!runtime) return;

  runtimeMap.delete(server);
  updateMcpAvailability();

  try {
    await runtime.client.close();
  } catch (e: any) {
    logger.warn('mcp_proxy：移除 Server 时关闭客户端失败', {
      module: 'Tool:McpProxy',
      server,
      error: e.message,
    });
  }

  logger.warn('mcp_proxy：Server 已从运行时列表移除', {
    module: 'Tool:McpProxy',
    server,
    reason,
    activeServers: Array.from(runtimeMap.keys()).join(','),
  });
}

// ==================== 初始化 ====================

/**
 * 初始化所有 MCP Server 客户端
 * - 动态 import @modelcontextprotocol/sdk 避免未安装时模块加载报错
 * - 单个 server 启动失败不影响其他 server
 * - 每个 server 启动成功后立即拉取一次 tools/list 缓存到 runtime
 */
export async function initMcpProxy(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const servers = parseMcpServersConfig();
  if (servers.length === 0) {
    logger.info('mcp_proxy：未配置任何 MCP Server，跳过初始化', { module: 'Tool:McpProxy' });
    mcpAvailable = false;
    initializationCompleted = true;
    return;
  }

  // 动态 import：避免未安装包时 require 阶段报错
  let Client: any;
  let StdioClientTransport: any;
  try {
    // SDK 子路径采用 ESM 格式，注意保留 .js 后缀
    const clientMod = await import('@modelcontextprotocol/sdk/client/index.js');
    const transportMod = await import('@modelcontextprotocol/sdk/client/stdio.js');
    Client = clientMod.Client;
    StdioClientTransport = transportMod.StdioClientTransport;
  } catch (e: any) {
    logger.error('mcp_proxy：@modelcontextprotocol/sdk 未安装或加载失败，工具不可用', {
      module: 'Tool:McpProxy',
      error: e.message,
    });
    mcpAvailable = false;
    initializationCompleted = true;
    return;
  }

  // 串行初始化：MCP Server 子进程启动有 IO 开销，串行更稳定
  for (const cfg of servers) {
    try {
      // 通过 stdio 与子进程通信：transport 内部会 spawn 子进程
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
      });
      // Client 名字仅用于身份标识，对功能无影响
      const client = new Client({ name: 'jerry-llm-server', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);

      // 拉取 tools/list 作为健康检查：连接成功但无法列出工具时视为不可用
      const listResp = await client.listTools();
      const tools = (listResp?.tools || []).map((t: any) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

      if (tools.length === 0) {
        await client.close();
        logger.warn('mcp_proxy：Server 未暴露任何工具，已跳过', {
          module: 'Tool:McpProxy',
          server: cfg.name,
        });
        continue;
      }

      runtimeMap.set(cfg.name, { config: cfg, client, tools });
      updateMcpAvailability();
      logger.info('mcp_proxy：Server 健康检查通过，初始化成功', {
        module: 'Tool:McpProxy',
        server: cfg.name,
        toolsCount: tools.length,
        toolNames: tools.map((t: any) => t.name).join(','),
      });
    } catch (e: any) {
      // 单个 server 失败不影响整体
      logger.error('mcp_proxy：Server 初始化失败，已跳过', {
        module: 'Tool:McpProxy',
        server: cfg.name,
        error: e.message,
      });
    }
  }

  updateMcpAvailability();
  initializationCompleted = true;
  logger.info('mcp_proxy：初始化完成', {
    module: 'Tool:McpProxy',
    activeServers: Array.from(runtimeMap.keys()).join(','),
    mcpAvailable,
  });
}

/**
 * 配置校验：本工具的"可用性"在 initMcpProxy 完成后才能确定
 * 这里仅做配置存在性检查，便于 buildToolsMap 阶段判断
 */
export function validateMcpProxyConfig(): boolean {
  const servers = parseMcpServersConfig();
  if (servers.length === 0) {
    logger.info('mcp_proxy 工具未配置：NOTIFY_MCP_SERVERS 为空', { module: 'Tool:McpProxy' });
    return false;
  }
  return true;
}

export function isMcpProxyAvailable(): boolean {
  if (!initializationCompleted) {
    return validateMcpProxyConfig();
  }
  return mcpAvailable;
}

// ==================== 工具 Schema ====================

/**
 * 构建 mcp_proxy 的 schema
 * 把所有 MCP Server 的工具列表展示在 description 中，
 * 让 LLM 能感知到具体可调用的工具集合
 */
export function buildMcpProxySchema(): any {
  // 把所有 server 的工具汇总成 "server.tool: description" 列表
  const lines: string[] = [];
  for (const [serverName, runtime] of runtimeMap.entries()) {
    for (const t of runtime.tools) {
      lines.push(`- ${serverName}.${t.name}${t.description ? `：${t.description}` : ''}`);
    }
  }
  const toolList = lines.length > 0 ? lines.join('\n') : '（暂无可用工具，请检查 MCP Server 是否启动成功）';

  return {
    type: 'function' as const,
    function: {
      name: 'mcp_proxy',
      description: `通过 MCP（Model Context Protocol）调用外部生态工具，例如 GitHub、Filesystem、Slack 等。
当前已接入的工具：
${toolList}
调用方式：传入 server（MCP Server 名称）+ tool（工具名）+ arguments（工具参数对象）。`,
      parameters: {
        type: 'object',
        properties: {
          server: {
            type: 'string',
            description: 'MCP Server 名称，必须是已配置的 server 之一',
          },
          tool: {
            type: 'string',
            description: 'MCP Server 暴露的工具名',
          },
          arguments: {
            type: 'object',
            description: '传给 MCP 工具的参数对象，结构由具体工具的 inputSchema 决定',
          },
        },
        required: ['server', 'tool'],
      },
    },
  };
}

// ==================== 类型 ====================

export interface McpProxyParams {
  server: string;
  tool: string;
  arguments?: Record<string, any>;
}

export interface McpProxyResult {
  success: boolean;
  /** MCP 工具返回的内容数组（结构由 MCP 协议定义） */
  content?: any[];
  /** 是否被 MCP Server 标记为错误结果 */
  isError?: boolean;
  error?: string;
}

// ==================== 主入口 ====================

/**
 * 路由调用到具体的 MCP Server
 *   1. 找到 server runtime
 *   2. 校验 tool 是否存在（fail fast，避免把错误参数传给 MCP）
 *   3. 调用 client.callTool() 转发参数
 *   4. 包装返回值
 */
export async function executeMcpProxy(params: McpProxyParams): Promise<McpProxyResult> {
  // 兜底：未初始化时尝试懒加载（避免 onModuleInit 顺序问题）
  if (!initialized) {
    await initMcpProxy();
  }

  const runtime = runtimeMap.get(params.server);
  if (!runtime) {
    return {
      success: false,
      error: `未找到 MCP Server "${params.server}"，已注册：${Array.from(runtimeMap.keys()).join(', ') || '(无)'}`,
    };
  }

  const toolMeta = runtime.tools.find((t) => t.name === params.tool);
  if (!toolMeta) {
    return {
      success: false,
      error: `Server "${params.server}" 不暴露工具 "${params.tool}"，可用工具：${runtime.tools.map((t) => t.name).join(', ')}`,
    };
  }

  logger.info('mcp_proxy：开始调用 MCP 工具', {
    module: 'Tool:McpProxy',
    server: params.server,
    tool: params.tool,
    argsPreview: JSON.stringify(params.arguments || {}).substring(0, 200),
  });

  try {
    // MCP SDK 的 callTool 返回 { content: [...], isError?: boolean }
    const resp = await runtime.client.callTool({
      name: params.tool,
      arguments: params.arguments || {},
    });

    const result: McpProxyResult = {
      success: !resp.isError,
      content: resp.content,
      isError: resp.isError,
    };
    logger.info('mcp_proxy：调用完成', {
      module: 'Tool:McpProxy',
      server: params.server,
      tool: params.tool,
      isError: !!resp.isError,
    });
    return result;
  } catch (e: any) {
    logger.error('mcp_proxy：调用失败', {
      module: 'Tool:McpProxy',
      server: params.server,
      tool: params.tool,
      error: e.message,
    });
    await removeRuntime(params.server, e.message || String(e));
    return { success: false, error: e.message || String(e) };
  }
}

/**
 * 关闭所有 MCP 客户端（用于服务优雅关闭）
 * 当前未在 main.ts 接入，留作扩展点
 */
export async function shutdownMcpProxy(): Promise<void> {
  for (const [name, runtime] of runtimeMap.entries()) {
    try {
      await runtime.client.close();
      logger.info('mcp_proxy：Server 已关闭', { module: 'Tool:McpProxy', server: name });
    } catch (e: any) {
      logger.warn('mcp_proxy：Server 关闭失败', { module: 'Tool:McpProxy', server: name, error: e.message });
    }
  }
  runtimeMap.clear();
  initialized = false;
  initializationCompleted = false;
  mcpAvailable = false;
}
