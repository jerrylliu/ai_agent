/**
 * 缓存 Alias 自学习模块（Level 3：结果验证 + Alias 自学习）
 *
 * 目标：用真实查询结果反向修正归一化盲区，系统越用越准。
 *
 * 三层容错架构定位：
 * - Level 1（精确匹配）：归一化 keywords SHA256 精确比对，O(1)
 * - Level 2（模糊匹配）：Jaccard 相似度 + 槽位兼容性，O(N)
 * - Level 3（本模块）：结果重叠率验证 → 建立 alias，下次 Level 1 直接命中
 *
 * 工作流程：
 * 1. Level 2 模糊匹配命中 keyB，用 keyB 的缓存结果作为本次查询结果
 * 2. 同时执行实际检索（或异步执行），得到本次查询的实际结果
 * 3. 比对实际结果与缓存结果的重叠率
 * 4. 重叠率 > 阈值 → 建立 alias：keyA → keyB（keyA 是当前查询的 key，keyB 是被复用的缓存 key）
 * 5. 下次查询生成 keyA 时，先查 alias 表，解析到 keyB，走 Level 1 精确匹配命中
 *
 * 注意：Level 3 是"乐观验证"模式——Level 2 命中时先返回缓存结果（不阻塞），
 * 异步执行实际检索并验证。如果验证发现重叠率低（误伤），撤销 alias。
 */

import { logger } from './logger.js';
import { eventBus } from './event-bus.js';

// ==================== 常量 ====================

/** 结果重叠率阈值：超过此值才认为两个查询语义等价，建立 alias */
const RESULT_OVERLAP_THRESHOLD = 0.7;

/** alias 最大数量（防止内存无限增长） */
const MAX_ALIASES = 200;

/** alias 的置信度阈值：连续 N 次验证通过才建立稳定 alias */
const CONFIDENCE_THRESHOLD = 2;

// ==================== 类型定义 ====================

/** 可比对的检索结果（只需 documentId 和 content 用于指纹） */
export interface ComparableResult {
  documentId?: string;
  content: string;
}

/** Alias 条目 */
interface AliasEntry {
  /** 源 key（当前查询生成的 key） */
  sourceKey: string;
  /** 目标 key（被复用的缓存 key） */
  targetKey: string;
  /** 验证通过次数（达到 CONFIDENCE_THRESHOLD 才稳定） */
  confidence: number;
  /** 是否已稳定（达到置信度阈值） */
  stable: boolean;
  /** 最后验证时间 */
  lastVerified: number;
  /** 最后验证的重叠率 */
  lastOverlapRate: number;
}

/** 结果验证结果 */
export interface VerificationResult {
  /** 是否通过验证（重叠率达标） */
  passed: boolean;
  /** 结果重叠率（0-1） */
  overlapRate: number;
  /** 是否建立了新 alias */
  aliasCreated: boolean;
  /** alias 是否已稳定 */
  aliasStable: boolean;
}

// ==================== 结果指纹 ====================

/**
 * 生成检索结果的指纹集合
 *
 * 用 documentId + content hash 作为文档唯一标识，
 * 两个结果集的指纹交集大小反映结果重叠程度。
 */
function buildResultFingerprints(results: ComparableResult[]): Set<string> {
  const fingerprints = new Set<string>();
  for (const result of results) {
    // 优先用 documentId + content 前 200 字符做指纹
    // 前 200 字符足以区分不同文档块，又避免全文 hash 的性能开销
    const docId = result.documentId || 'unknown';
    const contentHash = result.content.substring(0, 200);
    fingerprints.add(`${docId}::${contentHash}`);
  }
  return fingerprints;
}

/**
 * 计算两个结果集的重叠率
 *
 * 重叠率 = 交集大小 / 较小集合的大小
 * 用较小集合做分母：如果 A 有 3 个结果，B 有 5 个结果，A 的 3 个都在 B 中，
 * 重叠率 = 3/3 = 1.0（A 完全被 B 覆盖，可以复用 B 的缓存）
 */
function calculateOverlapRate(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersectionCount = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of smaller) {
    if (larger.has(item)) intersectionCount++;
  }

  return intersectionCount / smaller.size;
}

// ==================== Alias 自学习器 ====================

/**
 * 缓存 Alias 自学习器
 *
 * 维护 sourceKey → targetKey 的 alias 映射，通过结果验证积累置信度。
 * 达到置信度阈值的 alias 会在 Level 1 阶段直接解析，跳过 Level 2。
 *
 * 生命周期：全局单例，跨 FC 循环复用。
 */
export class CacheAliasLearner {
  /** sourceKey → AliasEntry */
  private aliases: Map<string, AliasEntry> = new Map();

  /**
   * 解析 alias：查询时先查 alias 表
   *
   * 在 Level 1 精确匹配之前调用：
   * - 如果 key 有稳定 alias → 返回 targetKey（走 Level 1 命中 targetKey 的缓存）
   * - 如果 key 无 alias 或 alias 不稳定 → 返回原 key
   *
   * @param key 当前查询生成的 cache key
   * @returns 解析后的 key（可能是 alias target，也可能是原 key）
   */
  resolve(key: string): string {
    const entry = this.aliases.get(key);
    if (entry && entry.stable) {
      logger.debug('Alias 解析命中', {
        module: 'CacheAliasLearner',
        sourceKey: key,
        targetKey: entry.targetKey,
        confidence: entry.confidence,
        lastOverlapRate: entry.lastOverlapRate.toFixed(3),
      });
      return entry.targetKey;
    }
    return key;
  }

  /**
   * 验证并学习：比对实际结果与缓存结果，建立/增强 alias
   *
   * 在 Level 2 模糊匹配命中后调用：
   * 1. 比对当前查询实际结果与缓存结果的重叠率
   * 2. 重叠率达标 → 增强 alias 置信度
   * 3. 置信度达阈值 → alias 稳定，下次 Level 1 直接解析
   * 4. 重叠率不达标 → 撤销 alias（防止误伤）
   *
   * @param sourceKey 当前查询的 cache key
   * @param targetKey 被复用的缓存 cache key
   * @param actualResults 当前查询的实际检索结果
   * @param cachedResults 缓存中的结果
   * @returns 验证结果
   */
  verifyAndLearn(
    sourceKey: string,
    targetKey: string,
    actualResults: ComparableResult[],
    cachedResults: ComparableResult[],
  ): VerificationResult {
    const actualFingerprints = buildResultFingerprints(actualResults);
    const cachedFingerprints = buildResultFingerprints(cachedResults);
    const overlapRate = calculateOverlapRate(actualFingerprints, cachedFingerprints);

    const passed = overlapRate >= RESULT_OVERLAP_THRESHOLD;
    const existing = this.aliases.get(sourceKey);
    // 跟踪本次操作的最终状态（用于返回值）
    let aliasCreated = false;
    let aliasStable = false;

    if (passed) {
      // 重叠率达标：增强置信度
      if (existing && existing.targetKey === targetKey) {
        // 已有 alias 且 targetKey 相同，增强置信度
        existing.confidence++;
        existing.stable = existing.confidence >= CONFIDENCE_THRESHOLD;
        existing.lastVerified = Date.now();
        existing.lastOverlapRate = overlapRate;
        aliasStable = existing.stable;

        logger.info('Alias 置信度增强（Level 3）', {
          module: 'CacheAliasLearner',
          sourceKey,
          targetKey,
          confidence: existing.confidence,
          stable: existing.stable,
          overlapRate: overlapRate.toFixed(3),
        });
      } else {
        // 新建 alias 或更换 targetKey（置信度从 1 开始重置）
        // 如果 alias 数量超限，淘汰最旧的非稳定 alias
        if (this.aliases.size >= MAX_ALIASES) {
          this.evictOldestUnstable();
        }

        const newEntry: AliasEntry = {
          sourceKey,
          targetKey,
          confidence: 1,
          stable: 1 >= CONFIDENCE_THRESHOLD,
          lastVerified: Date.now(),
          lastOverlapRate: overlapRate,
        };
        this.aliases.set(sourceKey, newEntry);
        aliasCreated = true;
        aliasStable = newEntry.stable;

        logger.info('Alias 新建（Level 3）', {
          module: 'CacheAliasLearner',
          sourceKey,
          targetKey,
          confidence: 1,
          stable: newEntry.stable,
          overlapRate: overlapRate.toFixed(3),
          replaced: existing ? existing.targetKey : null,
        });
      }
    } else {
      // 重叠率不达标：撤销已有 alias（防止误伤）
      if (existing) {
        this.aliases.delete(sourceKey);
        logger.warn('Alias 撤销——结果重叠率不达标（Level 3 防误伤）', {
          module: 'CacheAliasLearner',
          sourceKey,
          targetKey,
          overlapRate: overlapRate.toFixed(3),
          threshold: RESULT_OVERLAP_THRESHOLD,
        });
      } else {
        logger.debug('Alias 验证未通过——不建立 alias', {
          module: 'CacheAliasLearner',
          sourceKey,
          targetKey,
          overlapRate: overlapRate.toFixed(3),
          threshold: RESULT_OVERLAP_THRESHOLD,
        });
      }
    }

    return {
      passed,
      overlapRate,
      aliasCreated,
      aliasStable,
    };
  }

  /**
   * 行为验证：Level 2 模糊匹配命中时记录 alias 候选
   *
   * 与 verifyAndLearn 不同，此方法不做结果比对，纯靠"多次命中同一 targetKey"积累置信度。
   * 适用场景：Level 2 命中后直接返回缓存结果，无法获取实际检索结果做比对。
   *
   * 如果同一 sourceKey 多次模糊匹配到同一个 targetKey，说明它们语义等价，
   * 达到置信度阈值后 alias 稳定，下次走 Level 1 直接解析。
   *
   * @param sourceKey 当前查询的 cache key
   * @param targetKey Level 2 匹配到的缓存 cache key
   * @returns alias 是否已稳定
   */
  recordAliasHit(sourceKey: string, targetKey: string): boolean {
    const existing = this.aliases.get(sourceKey);

    if (existing && existing.targetKey === targetKey) {
      // 同一 targetKey 再次命中，增强置信度
      existing.confidence++;
      existing.stable = existing.confidence >= CONFIDENCE_THRESHOLD;
      existing.lastVerified = Date.now();

      logger.info('Alias 行为验证增强（Level 3）', {
        module: 'CacheAliasLearner',
        sourceKey,
        targetKey,
        confidence: existing.confidence,
        stable: existing.stable,
      });
      return existing.stable;
    }

    // 新建或更换 targetKey（重置置信度）
    if (this.aliases.size >= MAX_ALIASES) {
      this.evictOldestUnstable();
    }

    const newEntry: AliasEntry = {
      sourceKey,
      targetKey,
      confidence: 1,
      stable: 1 >= CONFIDENCE_THRESHOLD,
      lastVerified: Date.now(),
      lastOverlapRate: 0, // 行为验证无重叠率数据
    };
    this.aliases.set(sourceKey, newEntry);

    logger.info('Alias 行为验证新建（Level 3）', {
      module: 'CacheAliasLearner',
      sourceKey,
      targetKey,
      confidence: 1,
      stable: newEntry.stable,
    });
    return newEntry.stable;
  }

  /**
   * 淘汰最旧的非稳定 alias（内存保护）
   */
  private evictOldestUnstable(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.aliases) {
      if (!entry.stable && entry.lastVerified < oldestTime) {
        oldestTime = entry.lastVerified;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.aliases.delete(oldestKey);
    }
  }

  /**
   * 清除所有 alias
   */
  clearAll(): void {
    this.aliases.clear();
  }

  /**
   * 获取 alias 统计信息（调试用）
   */
  getStats(): { totalAliases: number; stableAliases: number } {
    let stable = 0;
    for (const entry of this.aliases.values()) {
      if (entry.stable) stable++;
    }
    return { totalAliases: this.aliases.size, stableAliases: stable };
  }
}

// ==================== 全局单例 ====================

/**
 * 全局 Alias 自学习器单例
 *
 * 跨 FC 循环复用，越用越准。
 * 监听 knowledge-base-updated 事件自动清空 alias（与 searchCache 一致），
 * 防止知识库更新后 alias 解析到已失效的 cacheKey。
 */
export const cacheAliasLearner = new CacheAliasLearner();

// 知识库更新时清空 alias（与 searchCache 保持一致）
eventBus.on('knowledge-base-updated', (reason: string) => {
  cacheAliasLearner.clearAll();
  logger.info('缓存 Alias 表已清空（知识库更新）', {
    module: 'CacheAliasLearner',
    reason,
  });
});
