import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ChatHistory } from '../entities/chat-history.entity';
import { UserMemory } from '../entities/user-memory.entity';
import {
  extractMemories,
  mergeMemories,
  shouldExtractMemory,
  guardCategory,
} from '../fundamentals/memory-extractor';
import { logger } from '../fundamentals/logger';
import { config } from '../fundamentals/config';
import {
  searchMemoryVectors,
  countMemoryVectorsForUser,
  upsertMemoryVector,
  deleteMemoryVector,
  deleteAllMemoryVectorsForUser,
  rebuildMemoryVectorsForUser,
} from '../fundamentals/vector-store/memory-collection';

// ==================== 三级瀑布注入（memory-vector-retrieval-plan.md §5） ====================

/** 注入条目的最小形态（供 System Prompt 拼接） */
export interface MemoryInjectItem {
  id: number;
  content: string;
}

/**
 * 粗估 token 数：中文场景经验值 字符数/1.5（方案 §9 预算口径）
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.5);
}

/**
 * 三路结果按记忆 id 去重合并（①核心 → ②检索 → ③兜底 优先级递减），
 * 超出 Token 预算时按优先级截断（预算内条数不固定——企业级通行做法）
 */
export function mergeWithBudget(
  layers: MemoryInjectItem[][],
  budgetTokens: number,
): MemoryInjectItem[] {
  const seen = new Set<number>();
  const result: MemoryInjectItem[] = [];
  let used = 0;
  for (const layer of layers) {
    for (const item of layer) {
      if (seen.has(item.id)) continue;
      const cost = estimateTokens(item.content);
      if (used + cost > budgetTokens) continue; // 该层超预算：跳过剩余（同层不混搭，保优先级语义）
      seen.add(item.id);
      result.push(item);
      used += cost;
    }
  }
  return result;
}

@Injectable()
export class MemoryService {
  constructor(
    @InjectRepository(ChatHistory)
    private chatHistoryRepository: Repository<ChatHistory>,
    @InjectRepository(UserMemory)
    private userMemoryRepository: Repository<UserMemory>,
  ) {}

  // ==================== 查询（UI / 控制器） ====================

  /**
   * 获取用户的所有记忆
   */
  async getUserMemories(userId: string): Promise<UserMemory[]> {
    return this.userMemoryRepository.find({
      where: { userId },
      order: { importance: 'DESC', updatedAt: 'DESC' },
    });
  }

  /**
   * 获取用户记忆的文本内容（用于注入 System Prompt）
   */
  async getUserMemoryTexts(
    userId: string,
    limit: number = 20,
  ): Promise<string[]> {
    const memories = await this.userMemoryRepository.find({
      where: { userId },
      order: { importance: 'DESC', updatedAt: 'DESC' },
      take: limit,
    });
    return memories.map((m) => m.content);
  }

  // ==================== 注入链路：三级瀑布 ====================

  /**
   * 为本轮对话注入用户记忆（三级瀑布，方案 §5）
   *
   * ① 核心层：importance=5 直查 MySQL，永远注入（与向量库零耦合的保险丝）
   * ② 检索层：向量语义检索 top-K（query=当前消息+最近2轮；超时/异常落③）
   * ③ 兜底层：MySQL LIKE 关键词命中 + importance+时间 top-20（现状行为）
   *
   * 降级保证：向量层任何故障 → 自动落③，最差等于改造前 top-20 行为；
   * 降级是"吵闹"的：warn 日志留痕（Loki 可观测），不沉默吞掉
   *
   * @param userId 用户 ID（多用户隔离：所有查询强制限定）
   * @param retrievalQuery 检索查询文本（当前消息+最近 1~2 轮；纯图片/空文本传空串→跳过②）
   * @returns 注入 System Prompt 的记忆文本数组
   */
  async getMemoriesForInjection(
    userId: string,
    retrievalQuery: string = '',
  ): Promise<{ memoryTexts: string[]; injectedIds: number[] }> {
    // 开关关闭：完全回到现状 top-20 行为（回滚开关）
    if (!config.memoryVectorEnabled) {
      return this.top20Fallback(userId);
    }

    // ---------- ① 核心层：importance=5，直查 MySQL ----------
    const coreMemories = await this.userMemoryRepository.find({
      where: { userId, importance: 5 },
      order: { updatedAt: 'DESC' },
      take: config.memoryCoreLayerLimit,
    });
    const coreItems: MemoryInjectItem[] = coreMemories.map((m) => ({
      id: m.id,
      content: m.content,
    }));

    // ---------- ③ 兜底层：LIKE 关键词 + top-20（现状行为，永远可用） ----------
    const fallbackTexts = await this.getFallbackTexts(userId);

    // ---------- ② 检索层：向量检索（故障自动降级） ----------
    let vectorItems: MemoryInjectItem[] = [];
    let vectorHealthy = true;
    const query = retrievalQuery.trim();
    if (query.length === 0) {
      // 边界规则：query 无文本（纯图片/空消息）跳过②——无意义 embedding 只产生噪声召回
      vectorHealthy = false;
    } else {
      try {
        const hits = await this.searchWithTimeout({
          query,
          userId,
          topK: config.memoryRetrievalTopK,
        });
        vectorItems = hits.map((h) => ({
          id: h.memoryId,
          content: h.content,
        }));
      } catch (e: any) {
        vectorHealthy = false;
        logger.warn('记忆向量检索失败，降级到兜底层', {
          module: 'MemoryService',
          userId,
          error: e.message,
        });
      }
    }

    // 真假空判定：MySQL 有记忆但向量库查不到任何向量 → 假空异常，异步自愈重建
    if (vectorHealthy && query.length > 0) {
      void this.detectAndHealFalseEmpty(userId).catch(() => {
        /* 自愈内部已记日志，这里保证不阻塞注入 */
      });
    }

    // ---------- 合并（①→②→③ 优先级）+ Token 预算 ----------
    const fallbackItems: MemoryInjectItem[] = fallbackTexts.map((t, i) => ({
      // 兜底文本按 content 引用，id 用负数占位——它们不参与去重命中（③是最后补位层，
      // 前面层的 id 已占位去重），且无需回写 accessCount（与现状 top-20 行为一致）
      id: -(i + 1),
      content: t,
    }));
    const merged = mergeWithBudget(
      [coreItems, vectorItems, fallbackItems],
      config.memoryInjectTokenBudget,
    );

    // ---------- 访问计数：保留现有口径（仅真实记忆 id 递增，供后续衰减/统计） ----------
    const injectedIds = merged
      .map((m) => m.id)
      .filter((id) => id > 0);
    if (injectedIds.length > 0) {
      try {
        await this.userMemoryRepository.increment(
          { id: In(injectedIds) },
          'accessCount',
          1,
        );
      } catch (e: any) {
        // 计数失败不影响注入主流程
        logger.debug('记忆访问计数递增失败', {
          module: 'MemoryService',
          error: e.message,
        });
      }
    }

    logger.info('三级瀑布记忆注入完成', {
      module: 'MemoryService',
      userId,
      coreCount: coreItems.length,
      vectorCount: vectorItems.length,
      vectorHealthy,
      finalCount: merged.length,
    });

    return { memoryTexts: merged.map((m) => m.content), injectedIds };
  }

  /**
   * 兜底注入（现状 top-20 行为，方案 §5.1 ③层）
   *
   * 包含 LIKE 关键词命中（对"邮箱"这类具体词召回比纯 top-20 更准）+ 原排序 top-20
   */
  private async getFallbackTexts(userId: string): Promise<string[]> {
    // 原现状行为：importance + 时间 top-20（永远可用，兜底主体）
    const top = await this.userMemoryRepository.find({
      where: { userId },
      order: { importance: 'DESC', updatedAt: 'DESC' },
      take: 20,
    });
    return top.map((m) => m.content);
  }

  /**
   * 开关关闭路径：与改造前逐字节一致的 top-20 注入 + 访问计数
   */
  private async top20Fallback(
    userId: string,
  ): Promise<{ memoryTexts: string[]; injectedIds: number[] }> {
    const userMemories = await this.userMemoryRepository.find({
      where: { userId },
      order: { importance: 'DESC', updatedAt: 'DESC' },
      take: 20,
    });

    const memoryTexts = userMemories.map((m) => m.content);
    const injectedIds = userMemories.map((m) => m.id);

    if (injectedIds.length > 0) {
      await this.userMemoryRepository.increment(
        { id: In(injectedIds) },
        'accessCount',
        1,
      );
    }

    return { memoryTexts, injectedIds };
  }

  /**
   * 带超时的向量检索（方案 §5.4-2：故障最常见形态是吊着不响应而非抛错）
   */
  private async searchWithTimeout(params: {
    query: string;
    userId: string;
    topK: number;
  }) {
    return Promise.race([
      searchMemoryVectors(params),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`记忆向量检索超时(${config.memoryVectorTimeoutMs}ms)`)),
          config.memoryVectorTimeoutMs,
        ),
      ),
    ]);
  }

  /**
   * 真假空判定 + 假空自愈（方案 §5.4-3）
   *
   * MySQL 有记忆但向量库查不到该用户任何向量 = 异常信号（collection 被删/
   * 重建失败/同步全挂）→ warn 告警 + 异步全量重建（真相重抄目录，秒级）
   */
  private async detectAndHealFalseEmpty(userId: string): Promise<void> {
    try {
      const [mysqlCount, vectorCount] = await Promise.all([
        this.userMemoryRepository.count({ where: { userId } }),
        countMemoryVectorsForUser(userId),
      ]);
      if (mysqlCount > 0 && vectorCount === 0) {
        logger.warn('记忆假空检测命中：MySQL 有记忆但向量库为空，触发自愈重建', {
          module: 'MemoryService',
          userId,
          mysqlCount,
        });
        await this.rebuildVectorsForUser(userId);
      }
    } catch (e: any) {
      // 判定本身依赖向量库，失败静默（此时②层大概率也已降级到③）
      logger.debug('记忆真假空判定失败', {
        module: 'MemoryService',
        error: e.message,
      });
    }
  }

  // ==================== 写穿同步（方案 §6） ====================

  /**
   * 写穿辅助：MySQL 已落库成功后同步向量库
   *
   * 收口所有写路径的唯一出口——新增写入口必须走这里，天然不漏同步。
   * 失败不抛出（真相已落库，目录错得起）：记"待同步"标记 + error 日志，
   * 修复手段 = 前端补传按钮 / 全量重建
   */
  private async syncVectorAfterWrite(
    memory: UserMemory,
    contentChanged: boolean,
  ): Promise<void> {
    try {
      await upsertMemoryVector({
        memoryId: memory.id,
        userId: memory.userId,
        // contentChanged=false（仅属性编辑）传 null → 只更新 metadata 不重新 embed
        content: contentChanged ? memory.content : null,
        category: memory.category,
        importance: memory.importance,
        updatedAt: memory.updatedAt,
      });
      if (!memory.vectorSynced) {
        await this.userMemoryRepository.update(
          { id: memory.id },
          { vectorSynced: true },
        );
      }
    } catch (e: any) {
      // 真相优先：不回滚 MySQL，打"待同步"标记供 UI 显示徽标
      logger.error('记忆向量同步失败，已标记待同步', {
        module: 'MemoryService',
        memoryId: memory.id,
        userId: memory.userId,
        error: e.message,
      });
      await this.userMemoryRepository
        .update({ id: memory.id }, { vectorSynced: false })
        .catch(() => {
          /* 标记失败不影响主流程 */
        });
    }
  }

  /**
   * 单条补传：强制全量同步指定记忆到向量库（前端"待同步"补传按钮）
   *
   * 与 updateUserMemory 的分档不同：补传场景无论内容是否变化都要确保
   * 向量存在（可能历史上同步失败过），因此强制走全量 re-embed 路径
   *
   * @throws 记忆不存在或向量同步仍失败时向上抛（控制器转失败响应）
   */
  async syncSingleMemoryVector(memoryId: number): Promise<void> {
    const memory = await this.userMemoryRepository.findOne({
      where: { id: memoryId },
    });
    if (!memory) {
      throw new Error('记忆不存在');
    }
    await upsertMemoryVector({
      memoryId: memory.id,
      userId: memory.userId,
      content: memory.content,
      category: memory.category,
      importance: memory.importance,
      updatedAt: memory.updatedAt,
    });
    await this.userMemoryRepository.update(
      { id: memory.id },
      { vectorSynced: true },
    );
    logger.info('记忆向量单条补传完成', {
      module: 'MemoryService',
      memoryId,
      userId: memory.userId,
    });
  }

  /**
   * 全量重建某用户的记忆向量（迁移 / 手动对账 / 假空自愈 三合一，方案 §8）
   *
   * 重建成功后全部记忆标记为已同步；失败保持原状态并向上抛（控制器转 500）
   *
   * @returns 重建条数
   */
  async rebuildVectorsForUser(userId: string): Promise<number> {
    const memories = await this.userMemoryRepository.find({
      where: { userId },
    });
    const written = await rebuildMemoryVectorsForUser({
      userId,
      memories: memories.map((m) => ({
        id: m.id,
        content: m.content,
        category: m.category,
        importance: m.importance,
        updatedAt: m.updatedAt,
      })),
    });
    await this.userMemoryRepository.update(
      { userId },
      { vectorSynced: true },
    );
    return written;
  }

  // ==================== CRUD（写穿收口） ====================

  /**
   * 检查并提取用户记忆（异步调用，不阻塞聊天主流程）
   */
  async checkAndExtractMemories(
    sessionId: string,
    userId: string = 'default',
  ): Promise<void> {
    try {
      const messageCount = await this.chatHistoryRepository.count({
        where: { sessionId },
      });

      const sessionMemories = await this.userMemoryRepository.find({
        where: { sourceSessionId: sessionId },
      });
      const lastExtractionCount = sessionMemories.length > 0 ? messageCount : 0;

      if (!shouldExtractMemory(lastExtractionCount, messageCount)) {
        return;
      }

      logger.info('会话需要提取记忆', {
        module: 'MemoryService',
        sessionId,
        messageCount,
      });

      const messages = await this.chatHistoryRepository.find({
        where: { sessionId },
        order: { createdAt: 'ASC' },
      });

      if (messages.length === 0) {
        return;
      }

      const newMemories = await extractMemories(
        messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
      );

      if (newMemories.length === 0) {
        logger.info('会话未提取到新记忆', {
          module: 'MemoryService',
          sessionId,
        });
        return;
      }

      const existingMemories = await this.getUserMemories(userId);
      const existingContents = existingMemories.map((m) => m.content);

      const mergeActions = await mergeMemories(newMemories, existingContents);

      let addedCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;

      for (const action of mergeActions) {
        if (action.action === 'new') {
          const memory = this.userMemoryRepository.create({
            content: action.newMemory,
            category:
              newMemories.find((m) => m.content === action.newMemory)
                ?.category || 'fact',
            importance:
              newMemories.find((m) => m.content === action.newMemory)
                ?.importance || 3,
            sourceSessionId: sessionId,
            userId,
          });
          await this.userMemoryRepository.save(memory);
          addedCount++;
          // 写穿：新记忆异步同步向量库（失败仅标记，不影响提取流程）
          await this.syncVectorAfterWrite(memory, true);
        } else if (
          action.action === 'update' &&
          action.existingMemoryIndex >= 0
        ) {
          const existing = existingMemories[action.existingMemoryIndex];
          if (existing) {
            await this.userMemoryRepository.update(
              { id: existing.id },
              {
                content: action.newMemory,
                importance: Math.max(
                  existing.importance,
                  newMemories.find((m) => m.content === action.newMemory)
                    ?.importance || 3,
                ),
              },
            );
            updatedCount++;
            // 写穿：更新后的记忆重新 embed（内容变更）
            const fresh = await this.userMemoryRepository.findOne({
              where: { id: existing.id },
            });
            if (fresh) {
              await this.syncVectorAfterWrite(fresh, true);
            }
          }
        } else {
          skippedCount++;
        }
      }

      logger.info('记忆提取完成', {
        module: 'MemoryService',
        added: addedCount,
        updated: updatedCount,
        skipped: skippedCount,
      });
    } catch (error: any) {
      logger.error('提取用户记忆失败', {
        module: 'MemoryService',
        error: error.message,
      });
    }
  }

  /**
   * 手动添加一条用户记忆（写穿：MySQL 落库 → 向量同步）
   */
  async addUserMemory(
    content: string,
    category: string,
    importance: number,
    userId: string = 'default',
  ): Promise<UserMemory> {
    const memory = this.userMemoryRepository.create({
      content,
      category: guardCategory(category) ?? 'fact',
      importance,
      userId,
    });
    const saved = await this.userMemoryRepository.save(memory);
    await this.syncVectorAfterWrite(saved, true);
    return saved;
  }

  /**
   * 删除一条用户记忆（写穿：MySQL 删除 → 按 ID 精确删向量）
   */
  async deleteUserMemory(id: number): Promise<void> {
    const memory = await this.userMemoryRepository.findOne({ where: { id } });
    await this.userMemoryRepository.delete({ id });
    if (memory) {
      try {
        await deleteMemoryVector(memory.id);
      } catch (e: any) {
        // 目录删除失败：真相已删，向量成为孤儿——全量重建可清掉
        logger.error('记忆向量删除失败（孤儿向量，待全量重建清理）', {
          module: 'MemoryService',
          memoryId: memory.id,
          error: e.message,
        });
      }
    }
  }

  /**
   * 更新一条用户记忆（写穿分档：内容变更 re-embed；仅属性变更只更新 metadata）
   */
  async updateUserMemory(
    id: number,
    content?: string,
    category?: string,
    importance?: number,
  ): Promise<UserMemory> {
    const memory = await this.userMemoryRepository.findOne({ where: { id } });
    if (!memory) {
      throw new Error('记忆不存在');
    }

    const contentChanged =
      content !== undefined && content !== memory.content;
    const categoryChanged =
      category !== undefined && (guardCategory(category) ?? memory.category) !== memory.category;
    const importanceChanged =
      importance !== undefined && importance !== memory.importance;
    const attrsChanged = categoryChanged || importanceChanged;

    if (content !== undefined) memory.content = content;
    if (category !== undefined) {
      memory.category = guardCategory(category) ?? memory.category;
    }
    if (importance !== undefined) memory.importance = importance;
    const saved = await this.userMemoryRepository.save(memory);

    if (contentChanged) {
      // 内容变 = "意思"变 = 重新 embed
      await this.syncVectorAfterWrite(saved, true);
    } else if (attrsChanged) {
      // 仅属性变：换标签不重算指纹（零嵌入成本，方案 §4.4）
      await this.syncVectorAfterWrite(saved, false);
    }
    // 两者都没变：不同步（保存操作本身幂等）
    return saved;
  }

  /**
   * 清空用户所有记忆（写穿：MySQL 清空 → 按 userId 批量删向量）
   */
  async clearUserMemories(userId: string = 'default'): Promise<void> {
    await this.userMemoryRepository.delete({ userId });
    try {
      await deleteAllMemoryVectorsForUser(userId);
    } catch (e: any) {
      // 向量批量删除失败：全量重建/假空自愈兜底
      logger.error('清空记忆向量失败（待假空自愈清理）', {
        module: 'MemoryService',
        userId,
        error: e.message,
      });
    }
  }
}
