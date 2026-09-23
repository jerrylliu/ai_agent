/**
 * KG 离线抽取管道（a4）
 *
 * 职责：把知识库文档抽取为实体/三元组，落 MySQL 三表（kg_entity / kg_triple /
 * kg_extract_op），并全量加载重建内存索引快照（fundamentals/kg/kg-index.ts）。
 * 在线链路（a5）只读内存快照，不触库。
 *
 * 调度模型（照抄 pending_vector_ops 状态机范式，不埋分散钩子）：
 * - @Interval 每 tick：差集扫描入队 + 限量消费 pending op；
 * - 差集入队 = ACTIVE 版本 vs 已完成/已失败的 EXTRACT op（按 versionId 比对），
 *   天然覆盖存量回填、版本更新重抽两种场景；
 * - KG 行存在但文档已无 ACTIVE 版本 → 入队 REMOVE_DOC 删行；
 * - KG_ENABLED=false 时调度直接 return，不产生任何 DB 查询（基线行为零变化）。
 *
 * 门闩红线：EXTRACT_PROMPT 与抽取口径 = scripts/bench/kg-link-spike.ts v2
 * （30 题门闩验证版本），任何改动都会使门闩结论失效，须重跑 30 题复核。
 */

import { Injectable, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import { KgEntity } from '../entities/kg-entity.entity.js';
import { KgTriple } from '../entities/kg-triple.entity.js';
import {
  KgExtractOp,
  KgOpStatus,
  KgOpType,
} from '../entities/kg-extract-op.entity.js';
import {
  DocumentVersion,
  VersionStatus,
} from '../entities/document-version.entity.js';
import { config } from '../fundamentals/config.js';
import { logger } from '../fundamentals/logger.js';
import { parseLlmJson } from '../fundamentals/llm-json-parser.js';
import { createRateLimitedLLM } from '../fundamentals/model-provider.js';
import {
  getActiveModelName,
  getEmbeddings,
} from '../fundamentals/vector-store/index.js';
import {
  DocExtractSchema,
  errMsg,
  mergeEntitiesByKey,
  normEntity,
} from '../fundamentals/kg/kg-core.js';
import { buildIndex, setKgIndexSnapshot } from '../fundamentals/kg/kg-index.js';
import type { DocEntityRow } from '../fundamentals/kg/kg-index.js';
import { DocumentService } from './document.service.js';

const MODULE = 'KgExtractService';

// ==================== 抽取提示词（spike v2 原样移植，勿改口径） ====================

const EXTRACT_PROMPT = `You are building a knowledge-graph index for a retrieval system.

From the document below, extract:
- "entities": the most important NAMED entities (people, teams, organizations, products, hardware models/SKUs, projects, initiatives, locations/regions, events, meetings, plans/policies, programs). Use the EXACT surface form as written in the document. Fill "aliases" with other forms of the SAME entity that appear in the document (abbreviation, full name, code name). At most ${config.kg.maxEntitiesPerDoc} entities, ordered by importance.
- "triples": factual relations between entities, as head/relation/tail. head and tail MUST be exact surface forms from the document. relation is a short lowercase snake_case phrase (e.g. works_on, located_in, depends_on, approved_by, scheduled_for, measured_by). At most ${config.kg.maxEntitiesPerDoc} triples.

Rules:
- Use ONLY information present in the document. No outside knowledge, no guessing.
- Do NOT extract generic common nouns ("performance", "cost", "the team") unless they are proper names.
- Prefer specific identifiers (model numbers, region codes, program names) — they matter most for retrieval.
- "aliases" is CRITICAL for linking. Fill it aggressively with every other in-document form of the SAME entity, in BOTH directions:
  * region code <-> human-readable name ("eu-central-1" <-> "EU Central" / "Frankfurt region")
  * code name / internal name <-> market or product name ("dry run" <-> "rehearse_run_2026q1")
  * abbreviation <-> full name, SKU <-> product family ("H200" <-> "NVIDIA H200 80GB")
  * metric or policy name <-> the colloquial way the document refers to it ("canary rollout" <-> "rollout system")
  Only include forms that actually appear in the document text.
- Output ONLY a JSON object, no markdown fences:
{"entities":[{"name":"...","type":"...","aliases":["..."]}],"triples":[{"head":"...","relation":"...","tail":"..."}]}

Document:
`;

// ==================== 工具函数 ====================

/** 通用受限并发映射（worker 池模式，照抄 document-scan.service） */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results.push(await fn(items[currentIndex], currentIndex));
    }
  });
  await Promise.all(workers);
  return results;
}

// ==================== 抽取服务 ====================

@Injectable()
export class KgExtractService implements OnModuleInit {
  /** 防重入：上一 tick 未跑完时跳过本次触发 */
  private isRunning = false;

  constructor(
    @InjectRepository(KgEntity)
    private readonly entityRepo: Repository<KgEntity>,
    @InjectRepository(KgTriple)
    private readonly tripleRepo: Repository<KgTriple>,
    @InjectRepository(KgExtractOp)
    private readonly opRepo: Repository<KgExtractOp>,
    @InjectRepository(DocumentVersion)
    private readonly versionRepo: Repository<DocumentVersion>,
    private readonly documentService: DocumentService,
  ) {}

  /**
   * 启动加载：恢复崩溃遗留的 processing op + 全量重建内存索引。
   * 失败不阻塞服务启动——在线链路读不到快照时自动退回纯基线。
   */
  async onModuleInit(): Promise<void> {
    if (!config.kg.enabled) return;
    try {
      // 单实例消费 + isRunning 防重入下，启动时仍处于 processing 的 op 必是上次崩溃遗留
      const stuck = await this.opRepo.update(
        { status: KgOpStatus.PROCESSING },
        { status: KgOpStatus.PENDING },
      );
      if ((stuck.affected ?? 0) > 0) {
        logger.info('已恢复崩溃遗留的 KG 抽取操作', {
          module: MODULE,
          count: stuck.affected,
        });
      }
      await this.rebuildSnapshot();
    } catch (error) {
      logger.error('KG 启动加载失败（不阻塞服务，等待下一轮调度重建）', {
        module: MODULE,
        error: errMsg(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  /**
   * 调度入口：差集入队 + 限量消费 pending op，有数据变更时重建内存快照。
   * KG 关闭时直接 return（不产生任何 DB 查询）。
   */
  @Interval(config.kg.extractIntervalMs)
  async tick(): Promise<void> {
    if (!config.kg.enabled) return;
    if (this.isRunning) {
      logger.info('KG 抽取调度正在执行中，跳过本次触发', { module: MODULE });
      return;
    }
    // 全量重建进行中时避让：此时版本状态在批量翻转，差集扫描会误入队
    if (this.documentService.isReindexRunning()) {
      logger.info('向量全量重建进行中，跳过本次 KG 调度', { module: MODULE });
      return;
    }
    this.isRunning = true;
    try {
      await this.enqueueDiff();
      const changed = await this.consumePending();
      if (changed) await this.rebuildSnapshot();
    } catch (error) {
      logger.error('KG 抽取调度异常', {
        module: MODULE,
        error: errMsg(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    } finally {
      this.isRunning = false;
    }
  }

  // ==================== 差集入队 ====================

  /**
   * 扫描 ACTIVE 版本与已处理 op 的差集，自动入队 EXTRACT / REMOVE_DOC。
   * FAILED 的 op 也算「已处理」：同一版本不会被无限重抽，
   * 人工修复后删除该 op 行即可让差集扫描重新入队。
   */
  private async enqueueDiff(): Promise<void> {
    const activeVersions = await this.versionRepo.find({
      where: { status: VersionStatus.ACTIVE },
      select: ['id', 'documentId'],
    });

    // 开放态 op（pending/processing）：文档已有在途操作时不重复入队
    const openOps = await this.opRepo.find({
      where: { status: In([KgOpStatus.PENDING, KgOpStatus.PROCESSING]) },
      select: ['id', 'documentId'],
    });
    const openDocIds = new Set(openOps.map((o) => o.documentId));

    // 已处理 EXTRACT op：documentId → 最近一次处理的 versionId（按 id 升序遍历，后写覆盖）
    const doneOps = await this.opRepo.find({
      where: {
        operation: KgOpType.EXTRACT,
        status: In([KgOpStatus.COMPLETED, KgOpStatus.FAILED]),
      },
      select: ['id', 'documentId', 'versionId'],
      order: { id: 'ASC' },
    });
    const doneVersionByDoc = new Map<number, number>();
    for (const op of doneOps) {
      if (op.versionId != null)
        doneVersionByDoc.set(op.documentId, op.versionId);
    }

    let enqueued = 0;
    const activeDocIds = new Set<number>();
    for (const version of activeVersions) {
      activeDocIds.add(version.documentId);
      // 当前 ACTIVE 版本已抽取过 → 跳过；版本变了（激活新版本）→ 重抽
      if (doneVersionByDoc.get(version.documentId) === version.id) continue;
      if (openDocIds.has(version.documentId)) continue;
      await this.opRepo.insert({
        documentId: version.documentId,
        versionId: version.id,
        operation: KgOpType.EXTRACT,
        status: KgOpStatus.PENDING,
      });
      enqueued++;
    }

    // REMOVE_DOC：KG 行还在但文档已无 ACTIVE 版本（被删除或版本全部回退）
    const [entityDocRows, tripleDocRows] = await Promise.all([
      this.entityRepo
        .createQueryBuilder('e')
        .select('DISTINCT e.documentId', 'documentId')
        .getRawMany<{ documentId: number }>(),
      this.tripleRepo
        .createQueryBuilder('t')
        .select('DISTINCT t.documentId', 'documentId')
        .getRawMany<{ documentId: number }>(),
    ]);
    const kgDocIds = new Set<number>([
      ...entityDocRows.map((r) => Number(r.documentId)),
      ...tripleDocRows.map((r) => Number(r.documentId)),
    ]);
    for (const documentId of kgDocIds) {
      if (activeDocIds.has(documentId)) continue;
      if (openDocIds.has(documentId)) continue;
      await this.opRepo.insert({
        documentId,
        versionId: null,
        operation: KgOpType.REMOVE_DOC,
        status: KgOpStatus.PENDING,
      });
      enqueued++;
    }

    if (enqueued > 0) {
      logger.info('KG 抽取差集入队完成', {
        module: MODULE,
        enqueued,
        activeDocs: activeDocIds.size,
      });
    }
  }

  // ==================== 消费队列 ====================

  /**
   * 限量消费 pending op（maxOpsPerTick 防长阻塞，extractConcurrency 控模型并发）。
   * @returns 是否有成功落库的数据变更（决定要不要重建内存快照）
   */
  private async consumePending(): Promise<boolean> {
    const ops = await this.opRepo.find({
      where: { status: KgOpStatus.PENDING },
      order: { createdAt: 'ASC' },
      take: config.kg.maxOpsPerTick,
    });
    if (ops.length === 0) return false;

    // 先整体认领（processing）：崩溃后由 onModuleInit 恢复回 pending
    await this.opRepo.update(
      ops.map((o) => o.id),
      { status: KgOpStatus.PROCESSING },
    );

    // LLM 实例单轮共享（createRateLimitedLLM 自带限流保护，fast 池）
    let llm: BaseChatModel | null = null;
    const getLlm = (): BaseChatModel => {
      if (!llm) llm = createRateLimitedLLM(undefined, 'fast');
      return llm;
    };

    let changed = false;
    await mapWithConcurrency(ops, config.kg.extractConcurrency, async (op) => {
      try {
        if (op.operation === KgOpType.REMOVE_DOC) {
          await this.runRemove(op);
        } else {
          await this.runExtract(op, getLlm());
        }
        await this.opRepo.update(op.id, {
          status: KgOpStatus.COMPLETED,
          // TypeORM update() 不接受 null（QueryPartialEntity 类型限制），用空串清除上次失败信息
          errorMessage: '',
        });
        changed = true;
      } catch (error) {
        const retryCount = op.retryCount + 1;
        const exhausted = retryCount >= config.kg.maxRetries;
        await this.opRepo.update(op.id, {
          status: exhausted ? KgOpStatus.FAILED : KgOpStatus.PENDING,
          retryCount,
          errorMessage: errMsg(error),
        });
        logger.error('KG 抽取操作失败', {
          module: MODULE,
          opId: op.id,
          documentId: op.documentId,
          operation: op.operation,
          retryCount,
          exhausted,
          error: errMsg(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    });
    return changed;
  }

  /**
   * EXTRACT：读正文 → 截断 → LLM 抽取（zod 强校验）→ 事务内删旧插新 → 嵌入主名
   */
  private async runExtract(op: KgExtractOp, llm: BaseChatModel): Promise<void> {
    if (op.versionId == null) {
      throw new Error('EXTRACT 操作缺少 versionId');
    }
    const version = await this.versionRepo.findOne({
      where: { id: op.versionId },
    });
    if (!version) {
      // 版本已被删除：无可抽取，按完成处理（文档若仍有别的 ACTIVE 版本，差集扫描会重新入队）
      logger.warn('KG 抽取目标版本不存在，按完成处理', {
        module: MODULE,
        opId: op.id,
        documentId: op.documentId,
        versionId: op.versionId,
      });
      return;
    }

    const rawText = await this.documentService.getVersionText(version);
    if (!rawText || !rawText.trim() || rawText.startsWith('[解析失败:')) {
      // 走重试通道：文件短暂不可用（如正在写入）下一轮可能恢复
      throw new Error(
        `版本文本不可用：${rawText.startsWith('[解析失败:') ? rawText.slice(0, 200) : '内容为空或文件丢失'}`,
      );
    }
    const content = rawText.slice(0, config.kg.extractDocChars);

    // AbortSignal.timeout 真正取消在途请求（Promise.race 只放弃等待、不省 token）
    const rawResult = await llm.invoke(
      [new HumanMessage(EXTRACT_PROMPT + content)],
      { signal: AbortSignal.timeout(config.kg.extractTimeoutMs) },
    );
    const message =
      typeof rawResult.content === 'string' ? rawResult.content : '';
    const parsed = parseLlmJson(message, DocExtractSchema, {
      module: MODULE,
      documentId: op.documentId,
      versionId: version.id,
    });
    if (!parsed.success) {
      throw new Error(`LLM 抽取输出校验失败：${parsed.reason}`);
    }

    const extract = parsed.data;
    const merged = mergeEntitiesByKey(extract.entities);
    const embeddings = await this.embedNames(merged.map((m) => m.name));
    const embeddingModel = getActiveModelName();

    // 事务内「删该文档旧行 + 插新行」：增量更新的最小原子单位，
    // 中途失败不留半新半旧的混合行
    await this.entityRepo.manager.transaction(async (manager) => {
      await manager.delete(KgEntity, { documentId: op.documentId });
      await manager.delete(KgTriple, { documentId: op.documentId });
      if (merged.length > 0) {
        await manager.insert(
          KgEntity,
          merged.map((m, i) => ({
            documentId: op.documentId,
            versionId: version.id,
            key: normEntity(m.name),
            name: m.name,
            type: m.type,
            aliases: m.aliases,
            embedding: embeddings[i] ?? null,
            embeddingModel: embeddings[i] ? embeddingModel : null,
          })),
        );
      }
      if (extract.triples.length > 0) {
        await manager.insert(
          KgTriple,
          extract.triples.map((t) => ({
            documentId: op.documentId,
            versionId: version.id,
            head: t.head,
            relation: t.relation,
            tail: t.tail,
          })),
        );
      }
    });

    logger.info('KG 文档抽取完成', {
      module: MODULE,
      documentId: op.documentId,
      versionId: version.id,
      entities: merged.length,
      triples: extract.triples.length,
      embedded: embeddings.filter((e) => e !== null).length,
    });
  }

  /** REMOVE_DOC：删除该文档全部 KG 行（快照由调用方统一重建） */
  private async runRemove(op: KgExtractOp): Promise<void> {
    const [entityResult, tripleResult] = await Promise.all([
      this.entityRepo.delete({ documentId: op.documentId }),
      this.tripleRepo.delete({ documentId: op.documentId }),
    ]);
    logger.info('KG 文档行已删除', {
      module: MODULE,
      documentId: op.documentId,
      entities: entityResult.affected ?? 0,
      triples: tripleResult.affected ?? 0,
    });
  }

  /**
   * 批量嵌入实体主名（embedBatchSize 分批）。
   * 失败降级：对应实体 embedding=null，语义补充通道自动关闭该键，
   * 词汇通道（门闩主口径）不受影响——不阻塞抽取落库。
   */
  private async embedNames(names: string[]): Promise<Array<number[] | null>> {
    const result: Array<number[] | null> = Array.from(
      { length: names.length },
      () => null,
    );
    if (names.length === 0) return result;
    const embeddings = getEmbeddings();
    for (
      let start = 0;
      start < names.length;
      start += config.kg.embedBatchSize
    ) {
      const batch = names.slice(start, start + config.kg.embedBatchSize);
      try {
        const vectors = await embeddings.embedDocuments(batch);
        for (let i = 0; i < batch.length; i++) {
          result[start + i] = vectors[i] ?? null;
        }
      } catch (error) {
        logger.warn('KG 实体嵌入失败，该批降级纯词汇召回', {
          module: MODULE,
          batchSize: batch.length,
          error: errMsg(error),
        });
      }
    }
    return result;
  }

  // ==================== 内存快照重建 ====================

  /**
   * 全量加载三表 → 按 documentId 分组还原 DocEntityRow[] → buildIndex →
   * 成对原子替换进程级快照（index + keyToEmbedding）。
   * 公开方法：启动加载 / 调度变更后重建 / 未来管理端手动触发共用。
   */
  async rebuildSnapshot(): Promise<void> {
    const [entityRows, tripleRows] = await Promise.all([
      this.entityRepo.find({ order: { documentId: 'ASC', id: 'ASC' } }),
      this.tripleRepo.find({ order: { documentId: 'ASC', id: 'ASC' } }),
    ]);

    const rowByDoc = new Map<number, DocEntityRow>();
    const getRow = (documentId: number): DocEntityRow => {
      let row = rowByDoc.get(documentId);
      if (!row) {
        // documentId 转字符串：与在线检索结果的 documentId 形态对齐（spike 同口径）
        row = { documentId: String(documentId), entities: [], triples: [] };
        rowByDoc.set(documentId, row);
      }
      return row;
    };

    const keyToEmbedding = new Map<string, number[]>();
    for (const e of entityRows) {
      getRow(e.documentId).entities.push({
        name: e.name,
        type: e.type,
        aliases: e.aliases ?? [],
      });
      if (e.embedding && e.embedding.length > 0) {
        keyToEmbedding.set(e.key, e.embedding);
      }
    }
    for (const t of tripleRows) {
      getRow(t.documentId).triples.push({
        head: t.head,
        relation: t.relation,
        tail: t.tail,
      });
    }

    const index = buildIndex([...rowByDoc.values()]);
    setKgIndexSnapshot(index, keyToEmbedding);
    logger.info('KG 内存索引重建完成', {
      module: MODULE,
      documents: rowByDoc.size,
      entityRows: entityRows.length,
      keys: index.keyToLabel.size,
      tripleCount: index.tripleCount,
      embeddedKeys: keyToEmbedding.size,
    });
  }
}
