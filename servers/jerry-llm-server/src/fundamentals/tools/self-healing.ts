/**
 * fundamentals/tools/self-healing.ts
 *
 * Self-Healing Agent —— 工具自愈机制（中期方案）
 *
 * 设计目标：
 *   当工具返回结构化错误（含 suggestion）时：
 *   1. **追踪同一会话内每个工具的自愈尝试次数**，防止 LLM 陷入"反射循环"
 *   2. **在错误结果上追加 _selfHealing 元信息**，LLM 据此判断"是否再试一次"
 *   3. **达到上限自动止血**：把 suggestion 替换为"已达重试上限，请向用户说明"提示
 *
 * 为什么不在工具内部自动重试：
 *   - 不是所有错误都适合自动改参（比如"权限不足"，再试 100 次也是错）
 *   - 重试前一定要让 LLM "看一眼"，避免改错方向越改越糟
 *   - 自动重试会让 token 成本和延迟翻倍，应由 LLM 主导决策
 *
 * 设计取舍：
 *   - 用 sessionId+toolName 做 key，跨用户/跨会话独立计数
 *   - LRU 上限 1000 个 key，超出按 FIFO 淘汰（防内存泄漏）
 *   - 重试上限 N=2（首次 + 2 次自愈 = 最多 3 次调用），平衡成功率和成本
 *   - 30 分钟窗口：超过窗口算"新一次问题"，从 0 开始计
 *
 * 不引入 Redis：
 *   - 这是单次会话内的临时状态，进程重启即丢失也无所谓（用户会重新触发问题）
 *   - 后续如果做分布式，可以平滑迁移到 Redis（接口已经抽象成 Map）
 */

import { logger } from '../logger';

/** 单条计数项 */
interface AttemptEntry {
  count: number;
  expiresAt: number;
}

/** 最多记录多少个 (sessionId, toolName) 组合，超出 LRU 淘汰 */
const MAX_ENTRIES = 1000;
/** 每条记录的存活时间（毫秒）：30 分钟没有再次触发就重置 */
const ATTEMPT_TTL_MS = 30 * 60 * 1000;
/** 自愈最大尝试次数（不含首次）。N=2 意味着首次失败后最多再 2 次自愈，共 3 次调用 */
export const MAX_HEALING_ATTEMPTS = 2;

const attempts = new Map<string, AttemptEntry>();

function makeKey(sessionId: string | undefined, toolName: string): string {
  // sessionId 缺失时用 'global'，保证至少有一个 key（避免计数失效）
  return `${sessionId || 'global'}::${toolName}`;
}

/**
 * 自愈追踪决策的输入
 */
export interface SelfHealingInput {
  /** 工具名 */
  toolName: string;
  /** 会话标识，缺失则用 'global' 共享 */
  sessionId?: string;
  /**
   * 工具返回结果，必须是带 success 的对象（如 SendNotificationResult）。
   * 若 success=true 或没有 suggestion，本函数原样返回，不做任何加工。
   */
  result: any;
}

/**
 * 自愈追踪决策的输出
 */
export interface SelfHealingDecision {
  /** 加工后的最终结果（可能在 suggestion 上叠加 _selfHealing 元信息） */
  result: any;
  /** 本次是否消耗了自愈配额（即"工具失败且建议 LLM 重试"） */
  consumedAttempt: boolean;
  /** 本次发生时累计的自愈次数（0 = 首次失败，1/2/3 = 已自愈 N 次） */
  currentAttempt: number;
}

/**
 * 自愈追踪主入口：在 executeTool 末尾调用，包装工具结果。
 *
 * 流程：
 *   1) result.success === true → 重置计数（说明已修好了），原样返回
 *   2) result.success === false 且 !result.suggestion → 无可挽救建议，原样返回
 *   3) result.success === false 且 result.suggestion → 进入自愈：
 *      a) 累加该 (session, tool) 计数
 *      b) 若 count <= MAX_HEALING_ATTEMPTS → 在 suggestion 上贴 _selfHealing 元信息：
 *         { attempt: 1, maxAttempts: 2, shouldRetry: true }
 *      c) 若 count > MAX_HEALING_ATTEMPTS → 替换 suggestion.hint 为"已达重试上限"
 *         { attempt: 3, maxAttempts: 2, shouldRetry: false }
 */
export function applySelfHealing(input: SelfHealingInput): SelfHealingDecision {
  const { toolName, sessionId, result } = input;

  // 结果不是带 success 的对象 → 不参与自愈
  if (!result || typeof result !== 'object' || typeof result.success !== 'boolean') {
    return { result, consumedAttempt: false, currentAttempt: 0 };
  }

  const key = makeKey(sessionId, toolName);

  // 成功 → 清除计数
  if (result.success) {
    if (attempts.has(key)) {
      attempts.delete(key);
    }
    return { result, consumedAttempt: false, currentAttempt: 0 };
  }

  // 失败但无 suggestion → 没自愈建议，不算自愈
  if (!result.suggestion) {
    return { result, consumedAttempt: false, currentAttempt: 0 };
  }

  // ---- 失败 + 有 suggestion：进入自愈追踪 ----
  evictExpired();

  const existing = attempts.get(key);
  const now = Date.now();
  const newCount = existing && existing.expiresAt > now ? existing.count + 1 : 1;

  attempts.set(key, { count: newCount, expiresAt: now + ATTEMPT_TTL_MS });

  // LRU 上限
  if (attempts.size > MAX_ENTRIES) {
    const firstKey = attempts.keys().next().value;
    if (firstKey) attempts.delete(firstKey);
  }

  const shouldRetry = newCount <= MAX_HEALING_ATTEMPTS;
  const healingMeta = {
    attempt: newCount,
    maxAttempts: MAX_HEALING_ATTEMPTS,
    shouldRetry,
  };

  // 达到上限：把 hint 改成"放弃自愈"
  // 这样 LLM 不会再调工具，而是把错误告诉用户
  const enrichedSuggestion = shouldRetry
    ? { ...result.suggestion, _selfHealing: healingMeta }
    : {
        ...result.suggestion,
        hint:
          `[已达自愈上限 ${newCount}/${MAX_HEALING_ATTEMPTS}] 多次重试仍失败，请向用户说明问题：` +
          (result.suggestion.reason || '工具调用持续失败') +
          '。不要再次调用本工具。',
        _selfHealing: healingMeta,
      };

  logger.info('Self-Healing：追踪自愈尝试', {
    module: 'SelfHealing',
    toolName,
    sessionId: sessionId || 'global',
    attempt: newCount,
    shouldRetry,
  });

  return {
    result: { ...result, suggestion: enrichedSuggestion },
    consumedAttempt: true,
    currentAttempt: newCount,
  };
}

/** 清理过期项（懒清理，每次新写入时调一次） */
function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (entry.expiresAt <= now) {
      attempts.delete(key);
    }
  }
}

/** 仅测试用：重置全部计数 */
export function resetSelfHealingForTest(): void {
  attempts.clear();
}

/** 调试用：当前追踪条目数 */
export function getSelfHealingSize(): number {
  return attempts.size;
}
