/**
 * Single-Flight（请求合并 / 防缓存击穿）
 *
 * 解决的问题：缓存未命中的那一瞬间是最脆弱的。
 * N 个并发请求同时发现 miss，就会同时回源 —— 对 RAG 检索而言，
 * 一次回源 = 一次 Embedding 调用 + 一次 ChromaDB 向量检索
 * （混合检索还要再加一次 BM25 全量扫描）。多 Agent 并行拆解子查询时，
 * 同一个子查询经常在几十毫秒内被触发多次，全部原样落到向量库上。
 *
 * 做法：同一 key 的进行中 Promise 只保留一份，后到的请求直接挂在它上面等结果。
 * 与「加锁排队」的区别：这里不是把 N 次请求串行化（总耗时 N 倍），
 * 而是把 N 次回源压成 1 次（总耗时 1 倍），后到的请求白捡结果。
 *
 * ⚠️ 合并带来的新风险（必须由 timeoutMs 兜住）：
 * 后到的请求把自己的命运交给了第一个请求。若回源永久挂住
 * （典型场景：ChromaDB 所在网络出现黑洞，TCP 连上了但永不响应），
 * 这个 key 会永久留在 inflight 里，后续所有同 key 请求全部挂死 →
 * HTTP 连接不释放并持续堆积 → 文件描述符耗尽 → 整个 Node 进程
 * 无法再 accept 新连接，把飞书、语音、文档生成等无关功能一起带下水。
 * 单进程架构下这是唯一能跨功能域传播的故障路径，因此超时不是可选项。
 *
 * 项目内已有的同构实现见 feishu-notify.service.ts 的 tenant_access_token 获取，
 * 这里抽成通用原语供缓存层复用。
 */

import { logger } from './logger.js';

export class SingleFlight {
  /** 进行中的请求：key → 共享 Promise */
  private readonly inflight = new Map<string, Promise<unknown>>();

  /** 累计被合并掉的请求数，用于评估击穿压力（G2 容量治理指标之一） */
  private coalesced = 0;

  /** 累计因回源超时而放弃等待的次数，非 0 即说明下游存在挂死 */
  private timeouts = 0;

  /**
   * 执行 fn，同一 key 的并发调用共享同一个 Promise
   *
   * fn 抛错时，所有共享该 Promise 的调用方都会收到同一个异常 ——
   * 这是刻意的语义：回源失败就该让每个调用方都知道，
   * 不能只让第一个失败、其余的拿到 undefined 静默降级。
   *
   * @param key 去重键，通常就是缓存 key
   * @param fn 回源函数，只会在没有同 key 进行中请求时执行一次
   * @param timeoutMs 回源超时上限（毫秒）。超时后：
   *        ① 所有等待者（含被合并进来的）一起收到超时异常，由调用方降级；
   *        ② 该 key 立刻从 inflight 摘除，后续请求重新发起回源而不是继续挂在死 Promise 上。
   *        传 undefined / 非正数表示不设超时 —— 除非回源本身已有可靠超时，否则不要这么用。
   */
  do<T>(key: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      this.coalesced++;
      logger.debug('SingleFlight 合并并发请求', {
        module: 'SingleFlight',
        key,
        coalesced: this.coalesced,
        inflight: this.inflight.size,
      });
      return existing as Promise<T>;
    }

    // 用 async 包装而不是直接 fn()：fn 若同步抛错也能统一变成 rejected Promise，
    // 避免调用方要同时处理同步异常与异步异常两条路径
    const raw: Promise<T> = (async (): Promise<T> => fn())();

    // 存进 inflight 的必须是「带超时的那个」Promise：
    // 若存 raw，后来被合并进来的请求拿到的是没有超时保护的裸 Promise，
    // leader 超时脱身后它们会永远挂着 —— 等于超时只救了第一个人。
    const shared: Promise<T> =
      timeoutMs !== undefined && timeoutMs > 0
        ? this.withTimeout(raw, key, timeoutMs)
        : raw;

    this.inflight.set(key, shared);

    // 摘除前校验身份（防御性不变量）：inflight 里的条目只可能是 shared 自己，
    // 但超时路径会让 shared 先于 raw settle。若将来有人在超时回调里加一句显式 delete，
    // 或改成「超时后允许新请求立刻顶替同 key」，无条件的 delete 就会把新条目误删，
    // 让它失去合并保护（退化成 N 次回源）。这里加一次比较把这个坑堵死。
    const settle = (): void => {
      if (this.inflight.get(key) === shared) {
        this.inflight.delete(key);
      }
    };
    shared.then(settle, settle);

    return shared;
  }

  /**
   * 给回源 Promise 套一层超时
   *
   * 注意这只是「放弃等待」，不是「取消执行」：没有 AbortSignal 贯穿
   * Embedding / ChromaDB 客户端，底层请求仍会在后台跑完。
   * 目的是切断「挂死 → 连接堆积 → 进程假死」这条传播链，
   * 让调用方能降级返回，让后来的请求能重试。
   */
  private withTimeout<T>(
    raw: Promise<T>,
    key: string,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.timeouts++;
        // 超时后 raw 已经没有等待者了。它稍后 reject 时会变成 unhandledRejection，
        // 在 Node 默认策略下直接把整个进程带崩 —— 必须挂一个空 catch 把它接住。
        raw.catch(() => {
          /* 已放弃等待，结果不再有人消费 */
        });
        logger.error('SingleFlight 回源超时，已放弃等待并放行后续请求重试', {
          module: 'SingleFlight',
          key,
          timeoutMs,
          timeouts: this.timeouts,
          inflight: this.inflight.size,
        });
        reject(new Error(`回源超时（${timeoutMs}ms）：key=${key}`));
      }, timeoutMs);
      // 这个 timer 只是保险丝，不该阻止进程退出
      // （否则优雅停机和 Jest 都会被一个悬挂的句柄拖住）
      timer.unref();

      raw.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          // Error 实例原样透传：调用方依赖 error identity 判断「是不是同一次回源失败」，
          // 包一层新 Error 会让这个判断失效。只有非 Error 的 rejection（如 throw 'str'）才包装。
          if (err instanceof Error) {
            reject(err);
            return;
          }
          reject(new Error(`回源失败：${String(err)}`));
        },
      );
    });
  }

  /** 当前进行中的请求数 */
  get pending(): number {
    return this.inflight.size;
  }

  /** 累计被合并掉的并发请求数 */
  get coalescedCount(): number {
    return this.coalesced;
  }

  /** 累计回源超时次数，非 0 说明下游（向量库 / Embedding）出现过挂死 */
  get timeoutCount(): number {
    return this.timeouts;
  }

  /** 重置统计计数器（不中断进行中的请求） */
  resetStats(): void {
    this.coalesced = 0;
    this.timeouts = 0;
  }

  /**
   * 清空进行中记录（仅供测试使用）
   *
   * 注意这不会取消已经在执行的 Promise，只是让后续调用不再挂到它们上面。
   */
  clearForTest(): void {
    this.inflight.clear();
    this.coalesced = 0;
    this.timeouts = 0;
  }
}
