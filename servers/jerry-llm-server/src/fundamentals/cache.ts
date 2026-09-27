/**
 * LRU 缓存模块
 *
 * 基于内存的 LRU（Least Recently Used）缓存，用于缓存向量检索结果，
 * 避免相同查询重复执行 Embedding 计算和向量检索。
 *
 * 特性：
 * - LRU 淘汰策略：容量满时自动淘汰最久未访问的条目
 * - 双约束容量：条目数上限（maxEntries）+ 字节预算（maxTotalSize），取先到者触发淘汰
 * - TTL 过期：每个条目可设置生存时间，过期自动失效
 * - 单条大小限制：超过 maxItemSize 的结果不缓存，防止内存膨胀
 * - L2（Redis）二级缓存：getAsync / setAsync 走「L1 内存 → L2 Redis」两级，
 *   Redis 不可用时自动降级为纯内存缓存，绝不影响主流程
 * - 单飞防击穿：dedupe() 把同一 key 的并发回源压成一次
 * - 缓存统计：命中/未命中/淘汰/拒绝/合并等全量计数，提供统计查询接口
 * - 事件驱动失效：监听 knowledge-base-updated 事件自动清缓存（含 L2）
 *
 * 缓存 key 设计：hash(query + JSON.stringify(filter))
 * 确保不同过滤条件的查询不会串结果
 */

import { createHash } from 'crypto';
import type Redis from 'ioredis';
import { logger } from './logger.js';
import { eventBus } from './event-bus.js';
import { getRuntimeConfig, updateRuntimeConfig } from './runtime-config.js';
import { getRedis, isRedisReady } from './redis-client.js';
import { metrics } from './metrics.js';
import { SingleFlight } from './single-flight.js';

// ==================== 缓存条目 ====================

interface CacheEntry<V> {
  /** 缓存值 */
  value: V;
  /** 过期时间戳（ms），0 表示永不过期 */
  expireAt: number;
  /** 条目大小（字节，近似值） */
  size: number;
  /** 创建时间 */
  createdAt: number;
  /** 最后访问时间 */
  accessedAt: number;
}

// ==================== 缓存统计 ====================

export interface CacheStats {
  /** L1（内存）命中次数 */
  hits: number;
  /** L2（Redis）命中次数；Redis 未启用时恒为 0 */
  l2Hits: number;
  /** 未命中次数（L1、L2 都没有，必须回源） */
  misses: number;
  /** 综合命中率 = (hits + l2Hits) / (hits + l2Hits + misses) */
  hitRate: number;
  /** 当前条目数 */
  size: number;
  /** 最大条目数 */
  maxSize: number;
  /**
   * 当前条目的加权体积（KB）= 各条目 JSON 字节数之和
   *
   * 刻意不叫 memoryUsageKB：这里算的是序列化后的字节数，
   * 不是 V8 里的真实驻留内存（对象头、指针、Map 桶、字符串内部表示都没算进去），
   * 真实占用通常还要再乘一个 1.5~3 的系数。名字诚实一点，免得被当成 RSS 看。
   */
  weightedSizeKB: number;
  /** 字节预算上限（KB） */
  maxTotalSizeKB: number;
  /** 当前条目的平均大小（KB） */
  avgEntrySizeKB: number;
  /**
   * 当前条目大小的 95 分位（KB）
   *
   * 为什么平均值不够：检索结果的大小是长尾分布，平均值会被大量小结果拉低，
   * 掩盖「少数几条巨型结果吃掉大半预算」的事实。
   * avg × maxEntries 只是理论下限，p95 × maxEntries 才接近真实峰值。
   */
  p95EntrySizeKB: number;
  /** 因超过单条大小上限而被拒绝写入的次数 */
  rejectedOversize: number;
  /** 因单条体积就撑爆整个字节预算而被拒绝写入的次数 */
  rejectedBudget: number;
  /** 累计淘汰条目数 = evictedBySize + evictedByBudget + evictedByConfig */
  evictedTotal: number;
  /** 因条目数达到上限而淘汰的次数 */
  evictedBySize: number;
  /** 因字节预算超限而淘汰的次数 */
  evictedByBudget: number;
  /** 因 TTL 过期在读取时被回收的次数 */
  evictedByTTL: number;
  /** 因配置变更（容量/预算调小）而淘汰的次数 */
  evictedByConfig: number;
  /** 被单飞合并掉的并发回源次数，数值越高说明击穿压力越大 */
  coalescedRequests: number;
  /**
   * 单飞回源超时次数（累计），非 0 说明 Embedding / 向量库出现过挂死
   *
   * 这是所有缓存指标里最该配告警的一个：它比 l2Errors 更早触发 ——
   * Redis 挂了只是丢了加速层，而上游回源挂死意味着检索功能本身已经不可用。
   */
  dedupeTimeouts: number;
  /** L2（Redis）读写异常次数 */
  l2Errors: number;
  /** L2 是否已就绪（世代号已从 Redis 载入） */
  l2Enabled: boolean;
}

// ==================== LRU 缓存 ====================

/**
 * 缓存 key 文本归一化（L1 方案）
 *
 * 对查询文本做规范化处理，消除微小差异导致的缓存不命中：
 * - 多空格合并为单空格
 * - 前后空白去除
 * - 统一小写
 *
 * 进阶方案参考：
 * - L2 语义缓存（Semantic Cache）：用 embedding 余弦相似度匹配，如 GPTCache / RedisVL
 *   "什么是机器学习" ≈ "机器学习的定义" → 命中（语义相似而非文本相同）
 * - L3 分布式语义缓存（Distributed Semantic Cache）：Redis + embedding + 多实例共享
 *   适用于多节点部署，缓存跨实例共享，避免冷启动问题
 */
function normalizeCacheKeyText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 稳定序列化：按键名递归排序后再序列化
 *
 * JSON.stringify 的输出顺序依赖对象字面量的键插入顺序，
 * `{a:1,b:2}` 与 `{b:2,a:1}` 会产出不同字符串 → 不同缓存 key →
 * 同一个查询因为过滤条件构造顺序不同而反复回源，命中率被无谓拉低。
 */
function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(',')}}`;
}

/** 构造器默认值：与 DEFAULT_RUNTIME_CONFIG.cache 对齐，避免两处默认值漂移 */
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_ITEM_SIZE = 50 * 1024;
const DEFAULT_TTL = 5 * 60 * 1000;
const DEFAULT_MAX_TOTAL_SIZE = 32 * 1024 * 1024;

// ==================== L2（Redis）相关常量 ====================

/**
 * L2 TTL 相对 L1 的放大倍数
 *
 * L2 的价值在于活过 L1 淘汰与进程重启。若 TTL 与 L1 相同，
 * 后端一重启，L2 里的条目也刚好到期，等于白存。
 * 知识库变更导致的失效由世代号（generation）即时兜住，不依赖 TTL，
 * 所以这里可以放心放大。
 */
const L2_TTL_MULTIPLIER = 6;
/** L2 TTL 上限（秒）：防止 L1 配了很长的 TTL 后 Redis 里堆积过期数据 */
const L2_MAX_TTL_SEC = 24 * 60 * 60;
/** L1 设为「永不过期」（TTL=0）时 L2 使用的兜底 TTL（秒） */
const L2_FALLBACK_TTL_SEC = 60 * 60;
/** L2 TTL 抖动比例：±10%，避免同一批写入的 key 在同一秒集体过期（雪崩） */
const L2_TTL_JITTER_RATIO = 0.1;

/**
 * L2 缓存值的结构版本号，内嵌在 key 里
 *
 * 解决的问题：世代号（generation）只在 clear() 时推进，而**代码部署不触发 clear()**。
 * 于是「改了缓存值结构 → 部署 → Redis 里还是旧结构的 payload → 被当新结构用」，
 * 静默返回带废弃字段的数据，直到 TTL 自然过期才恢复正常。
 *
 * 为什么不改成「每次进程启动就推进世代号」：那会让 L2 完全失去意义 ——
 * L2 存在的唯一理由就是活过进程重启（冷启动兜底），一重启就作废等于没做。
 *
 * 正确用法：**只要改动了写入 L2 的值结构，就把这个数字 +1**。
 * 版本号一变，所有旧 key 立刻不可达，靠 TTL 自行回收；
 * 而同一份代码的普通重启不会 bump，缓存照常命中。
 *
 * 版本记录：
 * - 1：含 `_childContent` 与 `metadata.parent_content` 冗余字段的旧结构
 * - 2：C1 瘦身后的当前结构（删除上述两处冗余）
 */
const L2_SCHEMA_VERSION = 2;

/**
 * L2 失败日志的最小输出间隔（毫秒）
 *
 * Redis 故障期间每一次读写都会失败。若逐条打 warn，
 * 10 次检索/秒 × 1 小时 = 36000 条日志，会把 Loki 和磁盘一起压垮 ——
 * 一个「加速层挂了」的小故障就这样扩散成了「日志系统挂了」的大故障。
 * 节流后仍然保留准确信号：l2Errors 计数器照常累加，日志里带上被压掉的条数。
 */
const L2_WARN_INTERVAL_MS = 60 * 1000;

// ==================== 单飞（Single-Flight）相关常量 ====================

/**
 * 回源超时上限（毫秒）：30 秒，与项目内 EMBEDDING_TEST_TIMEOUT_MS / JUDGE_TIMEOUT_MS 对齐
 *
 * 这是**保险丝而不是延迟 SLO**：正常回源（Embedding + 向量检索）在秒级完成，
 * 30s 只在下游彻底挂死时触发。设得过短会误杀冷启动时的正常慢查询
 * （首次加载 Embedding 模型、BM25 索引重建）。
 *
 * 放在缓存层做默认值而不是让每个调用方自己传：超时是 single-flight 的**必要配件**
 * （合并把 N 次独立的超时机会压成了 1 次），依赖调用方记得传等于没有保护。
 */
const DEFAULT_DEDUPE_TIMEOUT_MS = 30_000;

/**
 * 消费端兜底：非法的正数配置回退到 fallback 并告警
 *
 * 这是三层防御的最后一层（runtime-config 写入校验 → 加载校验 → 这里）。
 * maxEntries / maxItemSize / maxTotalSize 为 0 或负数时，evictToFit() 里的
 * 超限判定恒真且取不到可删条目，会死循环阻塞事件循环（进程假死），
 * 所以绝不能把非正数写进实例字段。
 *
 * 注意不设最小值地板：单条上限被显式设成 10 字节这类极小值是合法用法
 * （相当于关闭缓存），只拒绝非正数与非有限数。
 */
function sanitizePositive(
  value: number,
  fallback: number,
  field: string,
): number {
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  logger.warn('缓存配置非法，已回退原值', {
    module: 'LRUCache',
    field,
    invalidValue: value,
    fallback,
  });
  return fallback;
}

export class LRUCache<V> {
  private cache = new Map<string, CacheEntry<V>>();
  /** 当前所有条目的序列化字节数之和（加权体积，非真实 RSS） */
  private totalSize = 0;

  // ==================== 统计计数器 ====================

  /** L1（内存）命中次数 */
  private hits = 0;
  /** L2（Redis）命中次数 */
  private l2Hits = 0;
  /** 未命中次数（L1、L2 都没有，必须回源） */
  private misses = 0;
  /** 因超过单条大小上限而被拒绝写入的次数 */
  private rejectedOversize = 0;
  /** 因腾不出字节预算空间而被拒绝写入的次数 */
  private rejectedBudget = 0;
  /** 因条目数达到上限而淘汰的次数 */
  private evictedBySize = 0;
  /** 因字节预算超限而淘汰的次数 */
  private evictedByBudget = 0;
  /** 因配置变更（容量 / 预算调小）而淘汰的次数 */
  private evictedByConfig = 0;
  /** 因 TTL 过期在读取时被回收的次数 */
  private evictedByTTL = 0;
  /** L2（Redis）读写异常次数 */
  private l2Errors = 0;

  // ==================== 单飞与 L2 ====================

  /** 单飞：把同一 key 的并发回源压成一次 */
  private readonly flight = new SingleFlight();
  /** L2 世代号，null 表示尚未从 Redis 载入（此期间 L2 视为不可用） */
  private l2Generation: number | null = null;
  /** 世代号载入中的 Promise，避免并发首次访问触发多次 Redis 往返 */
  private l2GenLoading: Promise<void> | null = null;
  /** 世代号载入完成前就收到了失效请求，载入后需要补做一次自增 */
  private l2ClearPending = false;
  /** 上一条 L2 失败日志的输出时间戳，0 表示还没输出过 */
  private lastL2WarnAt = 0;
  /** 自上一条 L2 失败日志以来被节流压掉的条数 */
  private suppressedL2Warns = 0;

  constructor(
    /** 最大缓存条目数 */
    private maxEntries: number = DEFAULT_MAX_ENTRIES,
    /** 单条结果最大大小（字节），超过的不缓存，默认 50KB */
    private maxItemSize: number = DEFAULT_MAX_ITEM_SIZE,
    /** 默认 TTL（毫秒），0 表示永不过期，默认 5 分钟 */
    private defaultTTL: number = DEFAULT_TTL,
    /**
     * 总字节预算（字节），与 maxEntries 构成双约束淘汰，默认 32MB
     *
     * 为什么条目数上限还不够：maxEntries 只约束「条数」，真实占用是
     * 条数 × 单条大小的乘积，而这个乘积在配置界面上完全看不出来。
     */
    private maxTotalSize: number = DEFAULT_MAX_TOTAL_SIZE,
    /** 缓存命名空间，用于 Prometheus 指标区分不同缓存实例，同时作为 L2 key 前缀 */
    private namespace: string = 'rag-search',
  ) {
    // 构造期兜底：调用方（含 runtime-config 脏值）可能传入 0 / 负数 / NaN
    this.maxEntries = sanitizePositive(
      maxEntries,
      DEFAULT_MAX_ENTRIES,
      'maxEntries',
    );
    this.maxItemSize = sanitizePositive(
      maxItemSize,
      DEFAULT_MAX_ITEM_SIZE,
      'maxItemSize',
    );
    this.maxTotalSize = sanitizePositive(
      maxTotalSize,
      DEFAULT_MAX_TOTAL_SIZE,
      'maxTotalSize',
    );
    // TTL 允许 0（永不过期），只把负数 / NaN 归零，避免条目一写入就过期
    this.defaultTTL =
      Number.isFinite(defaultTTL) && defaultTTL >= 0
        ? Math.floor(defaultTTL)
        : 0;

    // 监听知识库更新事件，自动清缓存
    eventBus.on('knowledge-base-updated', (reason: string) => {
      this.clear(reason);
    });
  }

  /**
   * 生成缓存 key
   * 将查询文本归一化后与过滤条件拼接，取 SHA256 哈希
   * 归一化确保 "AI Agent开发" 和 "AI Agent 开发" 生成相同的 key
   * 过滤条件走稳定序列化，确保键插入顺序不同也能命中同一条缓存
   */
  static makeKey(query: string, filter?: Record<string, any>): string {
    const normalized = normalizeCacheKeyText(query);
    const raw = `${normalized}|||${filter ? stableStringify(filter) : ''}`;
    return createHash('sha256')
      .update(raw, 'utf-8')
      .digest('hex')
      .substring(0, 16);
  }

  /** 记录一次读取的耗时分层指标 */
  private observeGet(layer: 'L1' | 'L2' | 'miss', startTime: number): void {
    metrics.cacheGetDuration.observe(
      { namespace: this.namespace, layer },
      (performance.now() - startTime) / 1000,
    );
  }

  /**
   * 获取缓存值（同步，只查 L1 内存）
   * 命中时将条目移到 Map 末尾（LRU 特性：最近访问的排后面）
   */
  get(key: string): V | undefined {
    return this.getL1(key, true);
  }

  /**
   * 读取 L1，可选择是否计入命中/未命中统计
   *
   * 为什么要拆出 countStats：getAsync() 在 L1 未命中后还要继续查 L2。
   * 如果这里直接记 miss，同一次请求会被同时记成 miss 与 l2Hit，
   * 命中率算出来大于 100%，分层指标全部失真。
   * 所以内部读取一律传 false，由调用方在确定最终归属后统一记账。
   */
  private getL1(key: string, countStats: boolean): V | undefined {
    const startTime = performance.now();
    const entry = this.cache.get(key);

    if (!entry) {
      if (countStats) {
        this.misses++;
        this.observeGet('miss', startTime);
      }
      logger.debug('缓存未命中', {
        module: 'LRUCache',
        key,
        totalEntries: this.cache.size,
        hits: this.hits,
        misses: this.misses,
      });
      return undefined;
    }

    // 检查是否过期
    if (entry.expireAt > 0 && Date.now() > entry.expireAt) {
      this.cache.delete(key);
      this.totalSize -= entry.size;
      this.evictedByTTL++;
      if (countStats) {
        this.misses++;
        this.observeGet('miss', startTime);
      }
      const ageMs = Date.now() - entry.createdAt;
      logger.debug('缓存条目已过期', {
        module: 'LRUCache',
        key,
        ageMs,
        ttlMs: entry.expireAt - entry.createdAt,
        sizeKB: (entry.size / 1024).toFixed(1),
      });
      return undefined;
    }

    // LRU：删除后重新插入，移到末尾
    this.cache.delete(key);
    entry.accessedAt = Date.now();
    this.cache.set(key, entry);

    if (countStats) {
      this.hits++;
      this.observeGet('L1', startTime);
    }
    const ageMs = Date.now() - entry.createdAt;
    logger.debug('缓存命中', {
      module: 'LRUCache',
      key,
      ageMs,
      sizeKB: (entry.size / 1024).toFixed(1),
      totalEntries: this.cache.size,
      hits: this.hits,
      misses: this.misses,
    });
    return entry.value;
  }

  /**
   * 按「条目数上限 + 字节预算」双约束淘汰最久未访问的条目
   *
   * @param incomingSize    即将写入的条目大小（字节），配置变更场景传 0
   * @param incomingEntries 即将新增的条目数：set() 传 1、配置变更传 0。
   *   这一位是刻意保留的：set() 需要 `size + 1 > maxEntries`（等价于原来的
   *   `size >= maxEntries`，为新条目腾位），而配置变更后只需 `size > maxEntries`
   *   （不淘汰多余的那一条）。合并成一个判定式会让两处语义互相污染。
   * @returns 两类淘汰各自的数量
   */
  private evictToFit(
    incomingSize: number,
    incomingEntries: 0 | 1,
  ): { byEntries: number; byBytes: number } {
    let byEntries = 0;
    let byBytes = 0;

    for (;;) {
      const overEntries = this.cache.size + incomingEntries > this.maxEntries;
      const overBudget = this.totalSize + incomingSize > this.maxTotalSize;
      if (!overEntries && !overBudget) break;

      // Map.keys().next() 的返回类型是 IteratorResult<string, any>，
      // 联合分支里的 value 会把整体推导成 any，这里显式收窄回 string
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        // 兜底：缓存已空仍满足超限条件（配置被设成极小值时会发生），
        // 不 break 就是死循环，会直接阻塞事件循环导致整个进程假死
        break;
      }
      const oldestEntry = this.cache.get(oldestKey);
      if (oldestEntry) {
        this.totalSize -= oldestEntry.size;
      }
      this.cache.delete(oldestKey);

      if (overEntries) byEntries++;
      else byBytes++;
    }

    return { byEntries, byBytes };
  }

  /**
   * 设置缓存值
   * 如果缓存已满或超出字节预算，淘汰最久未访问的条目（Map 迭代顺序：先插入的在前）
   *
   * @returns 是否成功写入 L1。调用方据此决定是否继续写 L2 ——
   *   被拒绝的条目本来就偏大，再往 Redis 里塞只会把内存问题
   *   转移成网络与 Redis 内存问题，没有收益。
   */
  set(key: string, value: V, ttl?: number): boolean {
    // 估算条目大小
    const size = this.estimateSize(value);

    // 超过单条大小限制，不缓存
    if (size > this.maxItemSize) {
      this.rejectedOversize++;
      logger.warn('缓存条目过大，跳过缓存', {
        module: 'LRUCache',
        key,
        sizeKB: (size / 1024).toFixed(1),
        maxItemSizeKB: (this.maxItemSize / 1024).toFixed(1),
        rejectedOversize: this.rejectedOversize,
      });
      return false;
    }

    // 单条就撑爆整个字节预算（用户把 maxTotalSize 调到比 maxItemSize 还小时会发生）。
    // 必须在淘汰之前拦掉：淘汰循环会把整个缓存清空，然后还是放不下这一条，
    // 结果是「一条永远写不进去的巨型条目顺手清空了全部缓存」。
    if (size > this.maxTotalSize) {
      this.rejectedBudget++;
      logger.warn('缓存条目超出总字节预算，跳过缓存', {
        module: 'LRUCache',
        key,
        sizeKB: (size / 1024).toFixed(1),
        maxTotalSizeKB: Math.round(this.maxTotalSize / 1024),
        rejectedBudget: this.rejectedBudget,
      });
      return false;
    }

    // 如果 key 已存在，先删除旧条目
    const existing = this.cache.get(key);
    if (existing) {
      this.totalSize -= existing.size;
      this.cache.delete(key);
    }

    // 双约束淘汰：条目数或字节预算任一超限都要腾地方
    const { byEntries, byBytes } = this.evictToFit(size, 1);
    if (byEntries > 0) {
      this.evictedBySize += byEntries;
    }
    if (byBytes > 0) {
      this.evictedByBudget += byBytes;
    }
    if (byEntries + byBytes > 0) {
      logger.info('缓存 LRU 淘汰', {
        module: 'LRUCache',
        evictedByEntries: byEntries,
        evictedByBytes: byBytes,
        reason: byBytes > 0 && byEntries === 0 ? '字节预算超限' : '容量已满',
        totalEntries: this.cache.size,
        maxEntries: this.maxEntries,
        weightedSizeKB: Math.round(this.totalSize / 1024),
        maxTotalSizeKB: Math.round(this.maxTotalSize / 1024),
      });
    }

    const now = Date.now();
    const effectiveTTL = ttl ?? this.defaultTTL;

    this.cache.set(key, {
      value,
      expireAt: effectiveTTL > 0 ? now + effectiveTTL : 0,
      size,
      createdAt: now,
      accessedAt: now,
    });

    this.totalSize += size;

    logger.debug('缓存写入', {
      module: 'LRUCache',
      key,
      sizeKB: (size / 1024).toFixed(1),
      ttlMs: effectiveTTL,
      totalEntries: this.cache.size,
      weightedSizeKB: Math.round(this.totalSize / 1024),
    });
    return true;
  }

  /**
   * 清空缓存（同时让 L2 的全部条目立刻失效）
   */
  clear(reason?: string): void {
    const count = this.cache.size;
    const memoryKB = Math.round(this.totalSize / 1024);
    this.cache.clear();
    this.totalSize = 0;

    // L2 也必须一起失效：知识库更新事件走的正是这条路，
    // 只清 L1 的话，紧接着的请求会从 Redis 里把旧结果原样捞回来。
    this.advanceGeneration();

    logger.info('缓存已清空', {
      module: 'LRUCache',
      reason: reason || '手动清空',
      clearedEntries: count,
      freedMemoryKB: memoryKB,
      l2Generation: this.l2Generation,
    });
  }

  // ==================== L2（Redis）二级缓存 ====================

  /**
   * 取 Redis 客户端，未就绪时返回 null
   *
   * 先判 isRedisReady() 再取实例：直接调 getRedis() 会在 REDIS_ENABLED=false
   * 或连接尚未建立时触发 ioredis 惰性建连，测试环境里会留下未释放的句柄让 Jest 挂住。
   */
  private getRedisIfReady(): Redis | null {
    if (!isRedisReady()) return null;
    return getRedis();
  }

  /** L2 世代号的 Redis key（ioredis 会自动加上 keyPrefix） */
  private l2GenKey(): string {
    return `${this.namespace}:gen`;
  }

  /** L2 数据 key：结构版本号 + 世代号都内嵌其中，任一推进后旧 key 自动不可达 */
  private l2Key(key: string, generation: number): string {
    return `${this.namespace}:v${L2_SCHEMA_VERSION}:g${generation}:${key}`;
  }

  /**
   * L2 失败日志（带节流）
   *
   * 为什么必须节流：Redis 故障期间每一次读写都会失败，逐条打 warn 会在几分钟内
   * 产出上万行日志，把 Loki 写入和磁盘一起压垮 —— 缓存这个小故障就扩散成了
   * 日志系统的大故障。节流后信号依然准确：l2Errors 计数器不受影响照常累加，
   * 放行的那条日志里会带上「期间压掉了多少条」。
   */
  private warnL2Throttled(
    message: string,
    meta: Record<string, unknown>,
  ): void {
    const now = Date.now();
    if (
      this.lastL2WarnAt !== 0 &&
      now - this.lastL2WarnAt < L2_WARN_INTERVAL_MS
    ) {
      this.suppressedL2Warns++;
      return;
    }
    logger.warn(message, {
      module: 'LRUCache',
      namespace: this.namespace,
      ...meta,
      suppressedSinceLastWarn: this.suppressedL2Warns,
      l2ErrorsTotal: this.l2Errors,
    });
    this.lastL2WarnAt = now;
    this.suppressedL2Warns = 0;
  }

  /**
   * 取 L2 世代号，首次访问时从 Redis 载入
   *
   * 载入失败或 Redis 未就绪时返回 null，调用方据此跳过 L2 ——
   * 宁可 miss 也不能误命中上一轮的旧数据。
   *
   * 每次调用都会重试载入，因此 Redis 晚于本模块启动也能自动接上
   * （main.ts 里 waitForRedisReady(5000) 在模块加载之后才执行）。
   */
  private async ensureGeneration(): Promise<number | null> {
    if (this.l2Generation !== null) return this.l2Generation;
    if (!this.l2GenLoading) {
      this.l2GenLoading = this.doLoadGeneration().finally(() => {
        this.l2GenLoading = null;
      });
    }
    await this.l2GenLoading;
    return this.l2Generation;
  }

  private async doLoadGeneration(): Promise<void> {
    try {
      const redis = this.getRedisIfReady();
      if (!redis) return; // 保持 null，下次访问再试

      const raw = await redis.get(this.l2GenKey());
      const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
      this.l2Generation = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;

      // 载入完成前就发生过 clear()：补做自增，否则上一轮的旧 key 会重新可达
      if (this.l2ClearPending) {
        this.l2ClearPending = false;
        this.advanceGeneration();
      }
    } catch (err) {
      this.l2Errors++;
      const e = err as Error;
      this.warnL2Throttled('L2 世代号载入失败，本次跳过 L2', {
        error: (e?.message || String(err)).slice(0, 200),
      });
    }
  }

  /**
   * 世代号自增：让当前所有 L2 key 立刻不可达
   *
   * 为什么不用 KEYS / SCAN 遍历删除：ioredis 的 keyPrefix 只作用于普通命令的
   * key 参数，不作用于 KEYS / SCAN 的 pattern，且返回值本身带前缀，
   * 再传给 DEL 会变成双重前缀（distributed-lock.ts 的启动锁清理曾因此静默失效）。
   * 世代号方案是 O(1) 且没有前缀歧义：旧 key 靠 TTL 自然回收，
   * 新写入自动落到新世代下。
   */
  private advanceGeneration(): void {
    if (this.l2Generation === null) {
      // 世代号还没载入就收到失效请求：记下待办，载入完成后补做。
      // 否则用一个凭空的小号覆盖 Redis 中更大的号，会让上一轮的旧 key 重新可达。
      this.l2ClearPending = true;
      return;
    }

    this.l2Generation += 1;
    const gen = this.l2Generation;

    try {
      const redis = this.getRedisIfReady();
      if (!redis) return;

      // 不 await：clear() 是同步签名，且 Redis 写失败只影响「旧数据多活一会儿」，
      // 不该让知识库更新事件的回调链因此抛错
      void redis.set(this.l2GenKey(), String(gen)).catch((err: unknown) => {
        this.l2Errors++;
        const e = err as Error;
        this.warnL2Throttled('L2 世代号写入失败', {
          generation: gen,
          error: (e?.message || String(err)).slice(0, 200),
        });
      });
    } catch (err) {
      // 同步兜底：advanceGeneration 由 clear() 调用，而 clear() 挂在
      // eventBus 的 'knowledge-base-updated' 监听器上。EventEmitter 的监听器
      // 同步抛错会中断 emit() 并让**排在后面的其他监听器全部收不到事件** ——
      // 缓存的一次 Redis 异常就这样波及到了知识库更新流程的其他环节。
      this.l2Errors++;
      const e = err as Error;
      this.warnL2Throttled('L2 世代号推进失败', {
        generation: gen,
        error: (e?.message || String(err)).slice(0, 200),
      });
    }
  }

  /**
   * 计算 L2 TTL（秒）：L1 TTL × 6，夹在 [1, 24h]，再加 ±10% 抖动
   *
   * 抖动的意义：同一批写入的 key 若 TTL 完全一致，会在同一秒集体过期，
   * 紧接着的并发请求全部回源（缓存雪崩）。
   */
  private computeL2TtlSeconds(l1TtlMs: number): number {
    const base =
      l1TtlMs > 0
        ? Math.floor((l1TtlMs / 1000) * L2_TTL_MULTIPLIER)
        : L2_FALLBACK_TTL_SEC;
    const capped = Math.min(Math.max(base, 1), L2_MAX_TTL_SEC);
    const jitter = capped * L2_TTL_JITTER_RATIO * (Math.random() * 2 - 1);
    return Math.max(1, Math.floor(capped + jitter));
  }

  private async readL2(key: string): Promise<V | undefined> {
    // 快速短路：Redis 未启用时不做任何 Promise 分配与世代号载入
    if (!isRedisReady()) return undefined;

    try {
      // ensureGeneration / getRedisIfReady 必须一起包进 try：
      // 它们今天确实不抛错，但那是 doLoadGeneration 内部实现细节构成的**隐式契约**，
      // 没有任何类型或注释在保护它。将来谁在里面加一行埋点或换个 Redis 客户端，
      // 异常就会穿透到检索链路 —— 而缓存层对外的承诺是「我挂了也只影响命中率」。
      const gen = await this.ensureGeneration();
      if (gen === null) return undefined;
      const redis = this.getRedisIfReady();
      if (!redis) return undefined;

      const raw = await redis.get(this.l2Key(key, gen));
      if (raw === null) return undefined;
      return JSON.parse(raw) as V;
    } catch (err) {
      this.l2Errors++;
      const e = err as Error;
      this.warnL2Throttled('L2 读取失败，降级为未命中', {
        key,
        error: (e?.message || String(err)).slice(0, 200),
      });
      return undefined;
    }
  }

  private async writeL2(key: string, value: V, ttlMs: number): Promise<void> {
    if (!isRedisReady()) return;

    try {
      // 同 readL2：世代号载入与客户端获取一并纳入 try，避免隐式契约被打破后异常穿透
      const gen = await this.ensureGeneration();
      if (gen === null) return;
      const redis = this.getRedisIfReady();
      if (!redis) return;

      await redis.set(
        this.l2Key(key, gen),
        JSON.stringify(value),
        'EX',
        this.computeL2TtlSeconds(ttlMs),
      );
    } catch (err) {
      this.l2Errors++;
      const e = err as Error;
      this.warnL2Throttled('L2 写入失败，仅保留 L1', {
        key,
        error: (e?.message || String(err)).slice(0, 200),
      });
    }
  }

  /**
   * 带 L2（Redis）的异步读取：L1 内存 → L2 Redis → 未命中
   *
   * 任何 Redis 异常都在内部降级为 miss 并计入 l2Errors，绝不向上抛：
   * 缓存是加速层，它挂了不能让整条检索链路失败。
   */
  async getAsync(key: string): Promise<V | undefined> {
    const startTime = performance.now();

    const l1 = this.getL1(key, false);
    if (l1 !== undefined) {
      this.hits++;
      this.observeGet('L1', startTime);
      return l1;
    }

    const l2 = await this.readL2(key);
    if (l2 !== undefined) {
      this.l2Hits++;
      this.observeGet('L2', startTime);
      // 回填 L1：TTL 用 L1 默认值而不是 L2 的剩余时间。
      // 条目在 L2 里可能已存活数倍于 L1 TTL，但世代号保证了它没有因
      // 知识库变更而失效，按 L1 语义重新计时是安全的。
      this.set(key, l2);
      logger.debug('L2 缓存命中并回填 L1', {
        module: 'LRUCache',
        namespace: this.namespace,
        key,
        l2Hits: this.l2Hits,
      });
      return l2;
    }

    this.misses++;
    this.observeGet('miss', startTime);
    return undefined;
  }

  /**
   * 带 L2（Redis）的异步写入
   *
   * L1 拒绝写入（单条超限 / 撑爆字节预算）时同样跳过 L2。
   */
  async setAsync(key: string, value: V, ttl?: number): Promise<boolean> {
    const cachedInL1 = this.set(key, value, ttl);
    if (!cachedInL1) return false;
    await this.writeL2(key, value, ttl ?? this.defaultTTL);
    return true;
  }

  /**
   * 单飞：同一 key 的并发回源只执行一次，其余请求共享结果
   *
   * 多 Agent 并行拆解子查询时，同一个子查询经常在几十毫秒内被触发多次，
   * 每次都是一整轮 Embedding + 向量检索。用法：
   * `await searchCache.dedupe(cacheKey, async () => 真实检索())`
   *
   * @param timeoutMs 回源超时上限，默认 30s。**不要传 0 关掉它**：
   *        合并把 N 次各自独立的超时机会压成了 1 次，一旦回源永久挂住，
   *        这个 key 会永久留在 inflight 里，后续同 key 请求全部挂死 →
   *        HTTP 连接堆积 → FD 耗尽 → 整个进程停止接受新连接，
   *        波及飞书 / 语音 / 文档生成等完全无关的功能。
   *        超时会抛异常，调用方需自行 catch 后降级（见 vector-search.ts）。
   */
  dedupe<T>(
    key: string,
    fn: () => Promise<T>,
    timeoutMs: number = DEFAULT_DEDUPE_TIMEOUT_MS,
  ): Promise<T> {
    return this.flight.do(key, fn, timeoutMs);
  }

  /**
   * 计算当前条目大小的 95 分位（字节）
   *
   * 直接遍历当前 Map 算精确值：getStats 只在 Prometheus 抓取与管理接口调用，
   * 不在检索热路径上，条目数量级（数百）下排序开销可忽略。
   * 维护增量分位数结构（如 t-digest）是为高频调用准备的，这里不值得。
   */
  private computeP95EntrySizeBytes(): number {
    const count = this.cache.size;
    if (count === 0) return 0;

    const sizes: number[] = [];
    for (const entry of this.cache.values()) {
      sizes.push(entry.size);
    }
    sizes.sort((a, b) => a - b);

    // ceil(n*0.95)-1：n=20 → 18（第 19 小），n=1 → 0
    const index = Math.min(count - 1, Math.ceil(count * 0.95) - 1);
    return sizes[Math.max(0, index)];
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): CacheStats {
    const entryCount = this.cache.size;
    const total = this.hits + this.l2Hits + this.misses;
    return {
      hits: this.hits,
      l2Hits: this.l2Hits,
      misses: this.misses,
      hitRate: total > 0 ? (this.hits + this.l2Hits) / total : 0,
      size: entryCount,
      maxSize: this.maxEntries,
      weightedSizeKB: Math.round(this.totalSize / 1024),
      maxTotalSizeKB: Math.round(this.maxTotalSize / 1024),
      avgEntrySizeKB:
        entryCount > 0 ? +(this.totalSize / entryCount / 1024).toFixed(2) : 0,
      p95EntrySizeKB: +(this.computeP95EntrySizeBytes() / 1024).toFixed(2),
      rejectedOversize: this.rejectedOversize,
      rejectedBudget: this.rejectedBudget,
      // 现算而非单独维护计数器：三个来源已各自累加，再加一个总数容易漂移
      evictedTotal:
        this.evictedBySize + this.evictedByBudget + this.evictedByConfig,
      evictedBySize: this.evictedBySize,
      evictedByBudget: this.evictedByBudget,
      evictedByTTL: this.evictedByTTL,
      evictedByConfig: this.evictedByConfig,
      coalescedRequests: this.flight.coalescedCount,
      dedupeTimeouts: this.flight.timeoutCount,
      l2Errors: this.l2Errors,
      l2Enabled: this.l2Generation !== null,
    };
  }

  /**
   * 获取 Prometheus 指标兼容的统计数据
   * 与 MultiLevelCache 的 CacheStatsProvider 接口对齐，
   * 供 metrics.registerCacheInstance 采集命中率/容量等 Gauge
   */
  getMetricsStats() {
    const total = this.hits + this.l2Hits + this.misses;
    return {
      namespace: this.namespace,
      l1Hits: this.hits,
      l2Hits: this.l2Hits,
      misses: this.misses,
      l2Errors: this.l2Errors,
      total,
      l1HitRate: total > 0 ? +(this.hits / total).toFixed(4) : 0,
      overallHitRate:
        total > 0 ? +((this.hits + this.l2Hits) / total).toFixed(4) : 0,
      l1Size: this.cache.size,
      l1MaxSize: this.maxEntries,

      // ==================== 容量治理扩展指标 ====================
      // 这些字段在 CacheStatsProvider 中声明为可选：MultiLevelCache 没有
      // 字节预算与单飞概念，强行要求会让它和 metrics.spec.ts 的 fake 全部编译失败。
      weightedSizeBytes: this.totalSize,
      maxTotalSizeBytes: this.maxTotalSize,
      avgEntrySizeBytes:
        this.cache.size > 0 ? Math.round(this.totalSize / this.cache.size) : 0,
      p95EntrySizeBytes: this.computeP95EntrySizeBytes(),
      rejectedOversize: this.rejectedOversize,
      rejectedBudget: this.rejectedBudget,
      evictedBySize: this.evictedBySize,
      evictedByBudget: this.evictedByBudget,
      evictedByTTL: this.evictedByTTL,
      evictedByConfig: this.evictedByConfig,
      coalescedRequests: this.flight.coalescedCount,
      dedupeTimeouts: this.flight.timeoutCount,
    };
  }

  /**
   * 重置统计计数器
   */
  resetStats(): void {
    this.hits = 0;
    this.l2Hits = 0;
    this.misses = 0;
    this.rejectedOversize = 0;
    this.rejectedBudget = 0;
    this.evictedBySize = 0;
    this.evictedByBudget = 0;
    this.evictedByConfig = 0;
    this.evictedByTTL = 0;
    this.l2Errors = 0;
    this.flight.resetStats();
  }

  /**
   * 更新配置
   *
   * 非法值（0 / 负数 / NaN）一律保留原值并告警，不抛错：
   * 这里处于消费端，抛错会让调用方（含启动流程）拿到未处理异常，
   * 真正的拦截已经由 runtime-config 的写入校验完成。
   *
   * 注意 maxItemSize / defaultTTL 只影响后续写入，不追溯已有条目
   * （已有条目按写入时的 TTL 过期），这是刻意保留的语义，前端已加说明。
   */
  updateConfig(options: {
    maxEntries?: number;
    maxItemSize?: number;
    defaultTTL?: number;
    maxTotalSize?: number;
  }): void {
    const oldConfig = {
      maxEntries: this.maxEntries,
      maxItemSize: this.maxItemSize,
      defaultTTL: this.defaultTTL,
      maxTotalSize: this.maxTotalSize,
    };

    /** 配置调小后立刻收敛到合法区间，淘汰量单独计入 evictedByConfig */
    const shrinkToFit = (changed: string): void => {
      const { byEntries, byBytes } = this.evictToFit(0, 0);
      const evictedCount = byEntries + byBytes;
      if (evictedCount > 0) {
        this.evictedByConfig += evictedCount;
        logger.info('缓存配置变更触发 LRU 淘汰', {
          module: 'LRUCache',
          evictedCount,
          changed,
          currentEntries: this.cache.size,
          weightedSizeKB: Math.round(this.totalSize / 1024),
        });
      }
    };

    if (options.maxEntries !== undefined) {
      this.maxEntries = sanitizePositive(
        options.maxEntries,
        oldConfig.maxEntries,
        'maxEntries',
      );
      // 新容量小于当前条目数时，淘汰多余的
      shrinkToFit('maxEntries');
    }
    if (options.maxTotalSize !== undefined) {
      this.maxTotalSize = sanitizePositive(
        options.maxTotalSize,
        oldConfig.maxTotalSize,
        'maxTotalSize',
      );
      // 新预算小于当前占用时，淘汰到预算以内
      shrinkToFit('maxTotalSize');
    }
    if (options.maxItemSize !== undefined) {
      this.maxItemSize = sanitizePositive(
        options.maxItemSize,
        oldConfig.maxItemSize,
        'maxItemSize',
      );
    }
    if (options.defaultTTL !== undefined) {
      // TTL 允许 0（永不过期），只拒绝负数 / NaN
      this.defaultTTL =
        Number.isFinite(options.defaultTTL) && options.defaultTTL >= 0
          ? Math.floor(options.defaultTTL)
          : oldConfig.defaultTTL;
    }

    logger.info('缓存配置已变更', {
      module: 'LRUCache',
      oldConfig,
      newConfig: {
        maxEntries: this.maxEntries,
        maxItemSize: this.maxItemSize,
        defaultTTL: this.defaultTTL,
        maxTotalSize: this.maxTotalSize,
      },
      requested: options,
      currentEntries: this.cache.size,
      weightedSizeKB: Math.round(this.totalSize / 1024),
    });
  }

  /**
   * 估算值的大小（字节）
   * 使用 JSON.stringify 粗略估算，对于大多数场景足够准确
   */
  private estimateSize(value: V): number {
    try {
      return Buffer.byteLength(JSON.stringify(value), 'utf-8');
    } catch {
      return 1024; // 序列化失败时给默认 1KB
    }
  }
}

// ==================== 全局缓存实例 ====================

/** 向量检索结果缓存（配置从 runtime-config 读取，支持前端动态修改） */
const _rc = getRuntimeConfig().cache;
export const searchCache = new LRUCache<any>(
  _rc.maxEntries,
  _rc.maxItemSizeKB * 1024,
  _rc.defaultTTLMinutes * 60 * 1000,
  _rc.maxTotalSizeMB * 1024 * 1024,
);

// 注册到 Prometheus 指标系统，每次 scrape /api/metrics 时自动采集命中率
metrics.registerCacheInstance('rag-search', {
  getStats: () => searchCache.getMetricsStats(),
});

/**
 * 获取缓存统计信息（供 API 接口调用）
 */
export function getCacheStats(): CacheStats {
  return searchCache.getStats();
}

/**
 * 更新缓存配置（供 API 接口调用，同时持久化到文件）
 *
 * @throws RuntimeConfigValidationError 参数非法时抛出，且不会改动内存缓存配置
 */
export function updateCacheConfig(options: {
  maxEntries?: number;
  maxItemSizeKB?: number;
  defaultTTLMinutes?: number;
  maxTotalSizeMB?: number;
}): void {
  // 先持久化（内部含严格校验，非法值抛错），再改内存：
  // 反过来的话内存已被改坏、抛错后与磁盘不一致，只能靠重启才能恢复
  updateRuntimeConfig({ cache: options });
  searchCache.updateConfig({
    maxEntries: options.maxEntries,
    maxItemSize:
      options.maxItemSizeKB !== undefined
        ? options.maxItemSizeKB * 1024
        : undefined,
    defaultTTL:
      options.defaultTTLMinutes !== undefined
        ? options.defaultTTLMinutes * 60 * 1000
        : undefined,
    maxTotalSize:
      options.maxTotalSizeMB !== undefined
        ? options.maxTotalSizeMB * 1024 * 1024
        : undefined,
  });
  logger.info('缓存配置已更新并持久化', { module: 'LRUCache', ...options });
}

/**
 * 获取缓存当前配置（供 API 接口调用）
 */
export function getCacheConfig() {
  return getRuntimeConfig().cache;
}

/**
 * 手动清空缓存（供 API 接口调用）
 */
export function clearCache(reason?: string): void {
  searchCache.clear(reason || 'API 手动清空');
}
