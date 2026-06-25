/**
 * 飞书事件业务处理（与传输协议解耦）
 *
 * 抽出 HTTP 回调（FeishuEventController）和长连接（FeishuWSClient）
 * 共用的卡片按钮点击处理逻辑，避免两套入口维护两份代码。
 *
 * 设计原则：
 *   - 纯函数，不依赖 NestJS DI、不依赖 HTTP 上下文
 *   - 日志通过参数注入（HTTP 模式用 Nest Logger，WS 模式用 Winston）
 *   - 返回值结构与原 Controller 保持兼容：
 *       { toast?, card?, code?, msg? }
 *     HTTP 模式直接作为响应体返回；
 *     WS 模式忽略返回值（卡片更新走 updateFeishuHITLCard 的 PATCH）。
 */
import {
  handleConfirmationResponse,
  getFeishuMessageIdForConfirmation,
  updateFeishuHITLCard,
  buildHITLResolvedCard,
} from './human-in-the-loop.js';
import { createHash } from 'crypto';
import { logger } from './logger.js';
import { acquireLock } from './distributed-lock.js';
import { getRedis, isRedisReady } from './redis-client.js';
import { config } from './config.js';
import {
  sendPlainTextMessage,
  sendCardMessage,
  sendImageMessage,
  updateCard,
  uploadImage,
  buildCardJson,
} from './feishu-notify.service.js';
import {
  buildSessionKey,
  clearChatSession,
  getOrCreateChatSession,
} from './feishu/feishu-chat-session.js';
import { splitMarkdownImages } from './feishu/feishu-markdown-image.js';
import { extractRichAssets, syncRichAssetsToFeishu } from './feishu/feishu-asset-sync.js';
import { createFeishuStreamEditor } from './feishu/feishu-message-throttle.js';
import { createFeishuFakeResponse } from './feishu/feishu-fake-response.js';

/** 极简日志接口，HTTP/WS 两套日志体系都能适配 */
export interface MinimalLogger {
  log?: (msg: string, context?: string) => void;
  warn?: (msg: string, context?: string) => void;
  error?: (msg: string, context?: string) => void;
}

export interface CardActionResult {
  code?: number;
  msg?: string;
  toast?: { type: string; content: string };
  card?: { type: string; data: Record<string, unknown> };
}

/**
 * 处理卡片按钮点击事件（B2/B3）
 *
 * 飞书 card.action.trigger 事件结构（节选）：
 *   {
 *     operator: { open_id, user_id, ... },
 *     action: { tag: "button", value: { action, confirmation_id } },
 *     context: { open_message_id, open_chat_id, ... },
 *   }
 *
 * 注意：飞书不返回 card_id，需要用 open_message_id 调用更新接口
 */
export async function processCardAction(
  event: any,
  logger: MinimalLogger,
  logContext = 'FeishuEventProcessor',
): Promise<CardActionResult> {
  const messageId: string | undefined =
    event?.context?.open_message_id ?? event?.open_message_id;
  const action = event?.action;
  const operatorId: string =
    event?.operator?.open_id || event?.operator?.user_id || 'unknown';

  if (!action?.value) {
    logger.warn?.('卡片按钮事件：缺少 action.value', logContext);
    return { code: 400, msg: 'missing action value' };
  }

  const { confirmation_id, action: actionType } = action.value as {
    confirmation_id?: string;
    action?: string;
  };
  const isConfirm = actionType === 'confirm';

  if (!confirmation_id || !actionType) {
    logger.warn?.(
      '卡片按钮事件：value 中缺少 confirmation_id 或 action',
      logContext,
    );
    return { code: 400, msg: 'missing fields' };
  }

  logger.log?.(
    `卡片按钮: confirmation_id=${confirmation_id}, action=${actionType}, operator=${operatorId}, messageId=${messageId}`,
    logContext,
  );

  // 1) 先取出关联的 feishuMessageId（兼容飞书未透传 open_message_id 的情况）
  const fallbackMessageId =
    messageId || getFeishuMessageIdForConfirmation(confirmation_id);

  // 2) 执行 HITL 确认/拒绝（source='feishu' 避免 HITL 内部再次反向更新卡片）
  const success = handleConfirmationResponse(
    confirmation_id,
    isConfirm,
    'feishu',
  );

  if (!success) {
    // confirmation 已被消费（重复点击）或已超时（5 分钟）。
    // 注意：必须返回 code=0，否则飞书会按 90 秒间隔重试 3 次（参考飞书 OpenAPI 文档）。
    // 用 toast 字段反馈给用户"已处理或已过期"，体验更好。
    logger.warn?.(
      `confirmation_id 未找到或已过期: ${confirmation_id}`,
      logContext,
    );
    return {
      code: 0,
      msg: 'ok',
      toast: {
        type: 'warning',
        content: '⚠️ 该审批请求已被处理或已超过 5 分钟有效期',
      },
    };
  }

  // 3) 更新卡片：按钮消失 + 显示结果
  //
  // 双保险：
  //   1) 通过返回值里的 card 字段：HTTP / WS 两条入口都会把这份 JSON 同步回包给飞书，
  //      飞书后端零延迟替换用户手机上的卡片（同步响应模式）
  //   2) 异步 PATCH /im/v1/messages/{id} 兜底：极少数情况下飞书没收到同步响应的 card
  //      字段（例如客户端版本不支持），靠 PATCH 仍然能更新到位
  const resolvedCard = buildHITLResolvedCard(
    '操作',
    isConfirm,
    `飞书用户 ${operatorId}`,
  );
  if (fallbackMessageId) {
    void updateFeishuHITLCard(
      fallbackMessageId,
      '操作',
      isConfirm,
      `飞书用户 ${operatorId}`,
    ).catch(() => {
      // 兜底 PATCH 失败不影响主流程
    });
  }

  return {
    toast: {
      type: isConfirm ? 'success' : 'info',
      content: isConfirm ? '✅ 已确认' : '❌ 已拒绝',
    },
    card: {
      type: 'raw',
      data: resolvedCard,
    },
  };
}

// ==================== D1/D2：飞书入站消息处理 ====================

/** 事件级幂等：Redis SETNX 窗口（防止飞书断线重连重放） */
const EVENT_DEDUP_TTL_SEC = 5 * 60;
const EVENT_DEDUP_KEY_PREFIX = 'feishu:event-dedup:';
/** Redis 不可用时的本地降级窗口（LRU 简化版） */
const localDedupSet = new Map<string, number>();
const LOCAL_DEDUP_MAX = 500;

/**
 * 检查并标记 event_id 已处理
 *
 * @returns true 表示这次是首次，可以继续处理；false 表示重放，应忽略
 */
async function tryMarkEventProcessed(eventId: string): Promise<boolean> {
  const redis = getRedis();
  if (redis && isRedisReady()) {
    try {
      // SET NX EX：原子操作，已存在返回 null
      const r = await redis.set(
        `${EVENT_DEDUP_KEY_PREFIX}${eventId}`,
        '1',
        'EX',
        EVENT_DEDUP_TTL_SEC,
        'NX',
      );
      return r === 'OK';
    } catch {
      /* 降级到本地 */
    }
  }
  // 本地降级
  const now = Date.now();
  // 清理过期项
  if (localDedupSet.size >= LOCAL_DEDUP_MAX) {
    for (const [k, t] of localDedupSet) {
      if (t < now) localDedupSet.delete(k);
    }
    // 还是满 → 清最早一半
    if (localDedupSet.size >= LOCAL_DEDUP_MAX) {
      const keys = Array.from(localDedupSet.keys()).slice(
        0,
        Math.floor(LOCAL_DEDUP_MAX / 2),
      );
      for (const k of keys) localDedupSet.delete(k);
    }
  }
  if (localDedupSet.has(eventId)) return false;
  localDedupSet.set(eventId, now + EVENT_DEDUP_TTL_SEC * 1000);
  return true;
}

/** 仅测试用：重置本地 dedup */
export function __resetFeishuEventDedupForTest(): void {
  localDedupSet.clear();
}

/**
 * 构建 D1/D2 流式回复卡片
 *
 * 关键原因：飞书 PATCH /im/v1/messages/{id} 只能更新互动卡片，不能更新普通 text 消息。
 * 如果用 msg_type=text 发占位，再 PATCH 会报：This message is NOT a card。
 */
function buildChatStreamCard(content: string, done = false): Record<string, unknown> {
  return buildCardJson({
    title: done ? 'AI 回复' : 'AI 回复中...',
    content: content || '思考中...',
    headerColor: done ? 'green' : 'blue',
  });
}

function isClearSessionCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return ['清空', '清空聊天记录', '重置会话', '/clear', '/reset'].includes(normalized);
}

/**
 * promptInvoker：注入器模式承接 AppService.prompt 的调用
 *
 * 不直接 import AppService 是因为：
 *   1. AppService 依赖 NestJS DI（TypeORM Repository 等），从模块外调用会失败；
 *   2. 这里只需要"用户文本 → 平台 Agent → 流式回写"，注入器更解耦；
 *   3. 保持 feishu-event-processor 是纯函数，便于单测 mock。
 *
 * 由 app.module.ts 的 OnModuleInit 钩子调用 setFeishuPromptInvoker 注入。
 */
export type FeishuPromptInvoker = (args: {
  message: string;
  sessionId: string;
  userId: string;
  res: any;
  isCancelled: () => boolean;
}) => Promise<void>;

/**
 * 落 assistant 历史的注入器
 *
 * 单独抽出来是因为 processIncomingMessage 不应该感知 SessionService（解耦），
 * 由 app.module.ts 注入一个"把 content 写到 chat_history"的函数即可。
 */
export type FeishuAssistantPersister = (args: {
  sessionId: string;
  userId: string;
  content: string;
}) => Promise<void>;

/**
 * 删除飞书会话对应的平台记录。
 * 飞书清空/重置指令使用它清理 Web 端 session/chat_history。
 */
export type FeishuSessionCleaner = (args: {
  sessionId: string;
  userId: string;
}) => Promise<void>;

/**
 * 查询某会话最近生成的文档（含文件 buffer），用于把 AI 生成的 PDF/Word
 * 同步成飞书原生文件消息。解耦：processIncomingMessage 不直接依赖 GeneratedDocumentService。
 */
export type FeishuDocumentFetcher = (args: {
  sessionId: string;
  afterMs: number;
}) => Promise<Array<{ key: string; filename: string; buffer: Buffer }>>;

let promptInvokerRef: FeishuPromptInvoker | null = null;
let assistantPersistRef: FeishuAssistantPersister | null = null;
let sessionCleanerRef: FeishuSessionCleaner | null = null;
let documentFetcherRef: FeishuDocumentFetcher | null = null;

/** 注入 promptInvoker —— 应用启动时调用一次 */
export function setFeishuPromptInvoker(invoker: FeishuPromptInvoker | null): void {
  promptInvokerRef = invoker;
}

/** 注入 assistant 历史持久化 —— 应用启动时调用一次 */
export function setFeishuAssistantPersister(persister: FeishuAssistantPersister | null): void {
  assistantPersistRef = persister;
}

/** 注入飞书会话清理器 —— 应用启动时调用一次 */
export function setFeishuSessionCleaner(cleaner: FeishuSessionCleaner | null): void {
  sessionCleanerRef = cleaner;
}

/** 注入会话文档查询器 —— 应用启动时调用一次 */
export function setFeishuDocumentFetcher(fetcher: FeishuDocumentFetcher | null): void {
  documentFetcherRef = fetcher;
}

/** 飞书消息 message 内容解析后的轻量结构 */
interface ParsedFeishuMessage {
  chatId: string;
  chatType: 'p2p' | 'group';
  senderOpenId: string;
  messageId: string;
  text: string;
  /** 群里是否 @ 到了机器人（p2p 永远为 true，统一逻辑） */
  mentionsBot: boolean;
}

/**
 * 解析飞书 im.message.receive_v1 事件
 *
 * 返回 null 表示这条消息不应处理（非文本 / 空内容 / 群里没 @AI / 系统消息等）
 */
function parseIncomingMessage(event: any): ParsedFeishuMessage | null {
  const message = event?.message;
  const sender = event?.sender;
  if (!message || !sender) return null;

  const chatId: string | undefined = message.chat_id;
  const messageId: string | undefined = message.message_id;
  const senderOpenId: string | undefined =
    sender.sender_id?.open_id ?? sender.open_id;
  const chatType: string | undefined = message.chat_type;
  if (!chatId || !messageId || !senderOpenId || !chatType) return null;
  if (chatType !== 'p2p' && chatType !== 'group') return null;

  // 仅处理文本消息（MVP 范围）；其他类型（image/file/post）直接忽略
  if (message.message_type !== 'text') return null;

  // 飞书 text 内容是 JSON 字符串 { text: "..." }
  let text = '';
  try {
    const parsed = JSON.parse(message.content || '{}');
    text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
  } catch {
    return null;
  }
  if (!text) return null;

  // 群聊场景：必须 @ 机器人才处理，避免噪音
  // 飞书 mentions 数组形如 [{ key: '@_user_1', id: { open_id }, name, ... }]
  // 机器人对应 entry key 出现在 text 里（如 "@_user_1 你好"），把这些占位符剥掉
  let mentionsBot = chatType === 'p2p'; // p2p 默认满足
  const mentions: Array<any> = Array.isArray(message.mentions) ? message.mentions : [];
  if (chatType === 'group' && mentions.length > 0) {
    logger.info('飞书群聊 mentions 解析', {
      module: 'FeishuEventProcessor',
      chatId,
      mentions: mentions.map((m) => ({
        key: m?.key,
        name: m?.name,
        openId: m?.id?.open_id,
        userId: m?.id?.user_id,
      })),
    });
  }
  if (chatType === 'group') {
    // 严格匹配：mentions 中必须包含 bot 自己的 open_id 才认为 @ 到了 AI
    // bot 的 open_id 通过环境变量 NOTIFY_FEISHU_BOT_OPEN_ID 配置
    const botOpenId = config.notify.feishuBotOpenId;
    if (botOpenId) {
      mentionsBot = mentions.some((m) => {
        const oid = m?.id?.open_id;
        return typeof oid === 'string' && oid === botOpenId;
      });
    } else {
      // 未配置 bot open_id → 宽松模式：mentions 非空就处理
      // 这是 MVP 兜底，建议尽快配置 NOTIFY_FEISHU_BOT_OPEN_ID
      mentionsBot = mentions.length > 0;
    }
  }
  for (const m of mentions) {
    if (m?.key) {
      text = text.split(m.key).join('').trim();
    }
  }

  if (!text) return null;

  const parsed: ParsedFeishuMessage = {
    chatId,
    chatType,
    senderOpenId,
    messageId,
    text,
    mentionsBot,
  };
  return parsed;
}

/**
 * 处理飞书入站消息（D1 群聊 @ AI / D2 私聊 AI）
 *
 * 调用方（feishu-ws-client）必须用 setImmediate 异步化，
 * 因为飞书长连接要求 handler 3 秒内返回（否则触发重试）。
 *
 * 整体流程：
 *   1. 解析事件 → 提取纯文本 + chat 维度
 *   2. 群聊未 @ AI 直接忽略
 *   3. 计算 sessionKey → 取/建 sessionId
 *   4. 抢会话锁（同 chat+sender 串行）
 *   5. 发占位消息"🤔 思考中..."
 *   6. 创建流式编辑器 + fakeRes
 *   7. 调注入的 promptInvoker（走平台主 Agent）
 *   8. flush 收尾
 *   9. 任何环节失败 → 发兜底文本告知用户
 */
export async function processIncomingMessage(
  event: any,
  log: MinimalLogger,
  logContext = 'FeishuEventProcessor',
): Promise<void> {
  // 长连接 SDK 传入的通常是 { header, event }，HTTP webhook 也是类似包裹结构；
  // 单测里直接传 event 本体。这里统一拆成业务 event，避免 message/sender 字段缺失。
  const payload = event?.event ?? event;

  // 事件级幂等：长连接断线重连可能重放近期事件，避免重复跑 Agent
  // event_id 由 SDK 适配后位置可能在 event.header.event_id / event.event_id / payload.event_id
  const eventId: string | undefined =
    event?.header?.event_id ?? event?.event_id ?? payload?.event_id;
  if (eventId) {
    const first = await tryMarkEventProcessed(eventId);
    if (!first) {
      log.log?.(`忽略重放事件: ${eventId}`, logContext);
      return;
    }
  }

  const parsed = parseIncomingMessage(payload);
  if (!parsed) {
    log.log?.('忽略：消息格式不可处理（非文本 / 空 / 字段缺失）', logContext);
    return;
  }
  if (parsed.chatType === 'group' && !parsed.mentionsBot) {
    log.log?.(
      `忽略：群聊消息未 @ 机器人（chatId=${parsed.chatId}）`,
      logContext,
    );
    return;
  }
  if (!promptInvokerRef) {
    log.warn?.(
      'promptInvoker 未注入，无法处理飞书消息（请检查 app.module.ts）',
      logContext,
    );
    await sendFeishuFallbackError(parsed, '后端 Agent 暂时不可用，请稍后再试');
    return;
  }

  // sessionKey + sessionId
  const sessionKey = buildSessionKey({
    chatType: parsed.chatType,
    chatId: parsed.chatId,
    senderOpenId: parsed.senderOpenId,
    ownerUserId: config.notify.feishuChatUserId || 'default',
  });
  const sessionId = await getOrCreateChatSession(sessionKey);

  if (isClearSessionCommand(parsed.text)) {
    const chatOwnerUserId = config.notify.feishuChatUserId || 'default';
    if (sessionCleanerRef) {
      try {
        await sessionCleanerRef({ sessionId, userId: chatOwnerUserId });
      } catch (e: any) {
        logger.warn('飞书清空会话：删除平台记录失败', {
          module: 'FeishuEventProcessor',
          sessionId,
          err: (e?.message || String(e)).slice(0, 200),
        });
        await sendFeishuFallbackError(parsed, '❌ 清空失败，请稍后再试');
        return;
      }
    }
    await clearChatSession(sessionKey);
    await sendPlainTextMessage(
      parsed.chatId,
      'chat_id',
      '已清空聊天记录，下一条消息将开启新会话。',
    );
    return;
  }

  // 会话锁：同一 sessionKey 不能并发跑两个 Agent
  // TTL 300s 与 chat.controller.ts 保持一致（覆盖最长流式响应）
  const lock = await acquireLock(`feishu-chat:${sessionId}`, 300);
  if (!lock) {
    // 锁被占（也可能 Redis 不可用，这里偏保守 —— 一律告知用户稍后）
    await sendFeishuFallbackError(parsed, '⏳ 上一条还在处理中，请等它返回后再发');
    return;
  }

  // 记录处理起点：finalize 时只同步本次新生成的文档，避免把历史文档重复发出去
  const processingStartMs = Date.now();

  let placeholderMessageId: string | undefined;
  try {
    // 发占位卡片（飞书 PATCH 只能更新互动卡片，不能更新普通 text 消息）
    const placeholder = await sendCardMessage(
      parsed.chatId,
      'chat_id',
      buildChatStreamCard('思考中...'),
    );
    if (!placeholder.success || !placeholder.messageId) {
      log.warn?.(
        `发送占位消息失败: ${placeholder.error ?? 'unknown'}`,
        logContext,
      );
      // 占位消息失败时降级：流式直接累积，最后一次性发完整消息
      placeholderMessageId = undefined;
    } else {
      placeholderMessageId = placeholder.messageId;
    }

    // 流式编辑器：注入 patcher 调 updateCard（卡片消息可 PATCH）
    // placeholderMessageId 不存在时 patcher 退化为 noop，最终走 finalize 发新消息
    const editor = createFeishuStreamEditor(async (text: string) => {
      if (!placeholderMessageId) {
        // 没有占位消息可编辑，仅记录文本，等 finalize 时统一发送
        return { success: true };
      }
      return updateCard(placeholderMessageId, buildChatStreamCard(text));
    });

    const fake = createFeishuFakeResponse(editor);

    // 超时兜底：飞书侧没有 Web 端"中止"按钮，给 Agent 设一个 5 分钟硬上限，
    // 避免 LLM 死循环或 Tool 卡住导致会话锁永远不释放
    const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      log.warn?.(
        `Agent 超过 ${PROMPT_TIMEOUT_MS / 1000}s 未结束，强制中止`,
        logContext,
      );
    }, PROMPT_TIMEOUT_MS);

    try {
      // 调主 Agent；userId 暂用 sender.open_id（未来 C 模块的反查可以打通到平台 user）
      await promptInvokerRef({
        message: parsed.text,
        sessionId,
        userId: `feishu:${parsed.senderOpenId}`,
        res: fake.res,
        isCancelled: () => timedOut,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }

    // 流式收尾：强制 flush 一次最终内容
    await fake.finalize();

    let finalCardAlreadyUpdated = false;

    // 飞书卡片 lark_md 不会把 Markdown 图片 / echarts / mermaid 代码块渲染成原生形态，
    // 这里先剥离图表/思维导图代码块，再剥离图片，卡片只展示文字；
    // 图片随后用 image 消息发原生图，图表/思维导图/文档随后用 syncRichAssetsToFeishu 发原生形态。
    const rawBuffer = editor.getBuffer();
    const { text: richStripped, charts, mindmaps } = extractRichAssets(rawBuffer || '');
    const { text: cardText, imageUrls } = splitMarkdownImages(richStripped);
    const hasAnyAsset = imageUrls.length > 0 || charts.length > 0 || mindmaps.length > 0;
    const displayText = cardText || (hasAnyAsset ? 'AI 生成了内容：' : '');

    // 超时场景：在最终内容尾部追加提示，并把 PATCH 一次完整写出
    if (timedOut && placeholderMessageId) {
      const finalText = (displayText || '') + '\n\n⏱️ 已达 5 分钟超时，本次中止';
      await updateCard(placeholderMessageId, buildChatStreamCard(finalText, true)).catch(() => {});
      finalCardAlreadyUpdated = true;
    }

    // 把 assistant 完整内容回传给上层（用于落 chat_history）
    // 注意：落库保留原始内容（含 Markdown 图片），保证 Web 端仍能渲染图片
    const finalContent = rawBuffer;
    if (assistantPersistRef && finalContent) {
      try {
        await assistantPersistRef({
          sessionId,
          userId: `feishu:${parsed.senderOpenId}`,
          content: finalContent,
        });
      } catch (e: any) {
        logger.warn('飞书：assistant 历史落库失败（忽略，不影响用户）', {
          module: 'FeishuEventProcessor',
          err: (e?.message || String(e)).slice(0, 200),
        });
      }
    }

    // 兜底：编辑没成功（比如占位消息发不出去），把完整内容作为新消息发出
    if (!placeholderMessageId && rawBuffer) {
      if (displayText) {
        await sendPlainTextMessage(parsed.chatId, 'chat_id', displayText);
      }
    } else if (placeholderMessageId && rawBuffer && !finalCardAlreadyUpdated) {
      // 无论流式阶段是否已经写过完整内容，结束时都必须再 PATCH 一次 done=true，
      // 否则卡片标题/颜色会一直停留在"AI 回复中..."。
      await updateCard(
        placeholderMessageId,
        buildChatStreamCard(displayText || '（已生成内容）', true),
      ).catch(() => {});
    } else if (placeholderMessageId && !rawBuffer) {
      // Agent 没输出任何内容，把占位卡片改成提示
      await updateCard(
        placeholderMessageId,
        buildChatStreamCard('（这次没有生成内容，请换种说法再试）', true),
      ).catch(() => {});
    }

    // 单独把图片作为飞书原生 image 消息发送（卡片/文本都无法原生渲染图片）
    for (let i = 0; i < imageUrls.length; i++) {
      const imageUrl = imageUrls[i];
      // 幂等 uuid：同一 session + 图片 url + 序号稳定派生，避免重试/重放发重复图片
      const imageUuid = createHash('md5')
        .update(`feishu-img|${sessionId}|${i}|${imageUrl}`)
        .digest('hex');
      await sendFeishuNativeImage(parsed.chatId, imageUrl, sessionId, imageUuid);
    }

    // 把图表/思维导图/文档同步为飞书原生消息（图表/思维导图渲染 PNG，文档发 file 消息）
    let docs: Array<{ key: string; filename: string; buffer: Buffer }> = [];
    if (documentFetcherRef) {
      try {
        docs = await documentFetcherRef({ sessionId, afterMs: processingStartMs });
      } catch (e: any) {
        logger.warn('飞书文档同步：查询会话文档失败，跳过', {
          module: 'FeishuEventProcessor',
          sessionId,
          err: (e?.message || String(e)).slice(0, 200),
        });
      }
    }
    if (charts.length > 0 || mindmaps.length > 0 || docs.length > 0) {
      await syncRichAssetsToFeishu({
        receiveId: parsed.chatId,
        receiveIdType: 'chat_id',
        charts,
        mindmaps,
        documents: docs,
        idempotencyBase: createHash('md5').update(`feishu-asset|${sessionId}|${processingStartMs}`).digest('hex'),
        sessionId,
      });
    }
  } catch (e: any) {
    logger.warn('飞书消息处理异常', {
      module: 'FeishuEventProcessor',
      sessionId,
      err: (e?.message || String(e)).slice(0, 500),
    });
    // 编辑/发送都用兜底通道
    if (placeholderMessageId) {
      await updateCard(
        placeholderMessageId,
        buildChatStreamCard(`❌ 处理失败：${e?.message || '未知错误'}`, true),
      ).catch(() => {});
    } else {
      await sendFeishuFallbackError(
        parsed,
        `❌ 处理失败：${e?.message || '未知错误'}`,
      );
    }
  } finally {
    await lock.release();
  }
}

/**
 * 把一张图片以飞书原生 image 消息发送出去。
 *
 * 飞书卡片/文本都无法原生渲染 Markdown 图片，所以需要：
 *   1. 先 uploadImage 把图片上传到飞书拿到 image_key
 *   2. 再用 sendImageMessage 发原生 image 消息
 * 任意环节失败只 warn，不抛（图片发送失败不应中断主流程）
 */
async function sendFeishuNativeImage(
  chatId: string,
  imageUrl: string,
  sessionId: string,
  uuid?: string,
): Promise<void> {
  try {
    const uploadResult = await uploadImage(imageUrl);
    if (!uploadResult.success || !uploadResult.key) {
      logger.warn('飞书原生图片：上传失败，跳过', {
        module: 'FeishuEventProcessor',
        sessionId,
        imageUrl: imageUrl.slice(0, 200),
        error: uploadResult.error,
      });
      return;
    }
    const sendResult = await sendImageMessage(chatId, 'chat_id', uploadResult.key, uuid);
    if (!sendResult.success) {
      logger.warn('飞书原生图片：发送失败', {
        module: 'FeishuEventProcessor',
        sessionId,
        error: sendResult.error,
      });
    }
  } catch (e: any) {
    logger.warn('飞书原生图片发送失败（忽略）', {
      module: 'FeishuEventProcessor',
      sessionId,
      err: (e?.message || String(e)).slice(0, 200),
    });
  }
}

/**
 * 兜底发一条文本消息（不依赖占位消息），用于早期失败 / 锁竞争 / Agent 未注入等场景
 * 失败仅 warn，不抛
 */
async function sendFeishuFallbackError(
  parsed: ParsedFeishuMessage,
  text: string,
): Promise<void> {
  try {
    await sendPlainTextMessage(parsed.chatId, 'chat_id', text);
  } catch (e: any) {
    logger.warn('飞书兜底消息发送失败（忽略）', {
      module: 'FeishuEventProcessor',
      err: (e?.message || String(e)).slice(0, 200),
    });
  }
}
