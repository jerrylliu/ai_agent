/**
 * KG 图谱只读查询控制器（档位3：图谱可视化面板的数据源）
 * 路由前缀：/api/kg（main.ts 无全局前缀，此处写完整路径）
 *
 * 设计原则：
 *   - 只读安全：全部 GET，直查 MySQL（kg_entity / kg_triple / kg_extract_op），
 *     不依赖内存快照与 KG_ENABLED 开关——KG 关闭时依然可查历史落库数据，
 *     响应中透传 enabled 字段供前端提示"在线链路未启用"。
 *   - 聚合口径与 buildIndex 一致：节点按 normEntity(name)=key 聚合，
 *     边端点同样归一，保证面板看到的图与在线检索用的图同源。
 *   - 不查 embedding 大字段：所有 find 均显式 select，避免拖出 json 向量列。
 */

import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { KgEntity } from '../entities/kg-entity.entity.js';
import { KgTriple } from '../entities/kg-triple.entity.js';
import { KgExtractOp } from '../entities/kg-extract-op.entity.js';
import { OptionalAuthGuard } from '../auth/optional-auth.guard.js';
import { config } from '../fundamentals/config.js';
import { normEntity } from '../fundamentals/kg/kg-core.js';
import { getKgIndexSnapshot } from '../fundamentals/kg/kg-index.js';

// ==================== 响应形状（面板契约） ====================

/** 聚合图节点（跨文档按 key 合并） */
interface GraphNode {
  /** 归一化实体键（normEntity 口径，与 kg_entity.key 一致） */
  key: string;
  /** 展示名（首现原始表述） */
  label: string;
  /** 实体类型（首个非 unknown 值优先） */
  type: string;
  /** 别名并集（上限 8 个，防节点 tooltip 爆炸） */
  aliases: string[];
  /** 出现过的文档 id 列表 */
  docIds: number[];
  /** 跨文档出现次数（>=2 即 hub 节点，面板可高亮） */
  docCount: number;
}

/** 聚合图边（同一无向关系对合并计数，展示方向取首现） */
interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  /** 该关系对在库中的三元组行数 */
  count: number;
}

/** 单文档子图节点（implicit = 仅出现在三元组端点、无实体行） */
interface DocGraphNode {
  key: string;
  label: string;
  type: string;
  aliases: string[];
  implicit?: boolean;
}

/** 单文档子图边（不聚合，一条三元组一行） */
interface DocGraphEdge {
  source: string;
  target: string;
  relation: string;
}

/** 聚合节点的内部可变形态（Set 收集，出参前转数组） */
interface AggNodeState {
  key: string;
  label: string;
  type: string;
  aliases: Set<string>;
  docIds: Set<number>;
  /** 关联边权重和（截断排序用：hub 优先、其次连接度） */
  degree: number;
}

/** 聚合边的内部可变形态 */
interface AggEdgeState {
  source: string;
  target: string;
  relation: string;
  count: number;
}

/** 节点别名并集上限（展示裁剪，不影响库中数据） */
const MAX_NODE_ALIASES = 8;

@Controller('api/kg')
// 读限流与 document / chat 控制器对齐（60 次/分钟）：面板打开时拉 2~3 次，轮询刷新也够用
@Throttle({ default: { ttl: 60000, limit: 60 } })
@UseGuards(OptionalAuthGuard)
export class KgGraphController {
  constructor(
    @InjectRepository(KgEntity)
    private readonly entityRepo: Repository<KgEntity>,
    @InjectRepository(KgTriple)
    private readonly tripleRepo: Repository<KgTriple>,
    @InjectRepository(KgExtractOp)
    private readonly opRepo: Repository<KgExtractOp>,
  ) {}

  /**
   * GET /api/kg/graph?limit=300
   * 全局聚合图：实体按 key 跨文档聚合，三元组按归一化端点对聚合计数。
   * limit 为节点数上限（clamp 到 10~1000）：超限时按 docCount desc → degree desc
   * 保留 hub 节点，边裁剪到保留节点集内并按 count desc 排序。
   */
  @Get('graph')
  async getGraph(
    @Query('limit', new DefaultValuePipe(300), ParseIntPipe) limit: number,
  ): Promise<{
    enabled: boolean;
    truncated: boolean;
    nodeCount: number;
    edgeCount: number;
    nodes: GraphNode[];
    edges: GraphEdge[];
  }> {
    const maxNodes = Math.min(Math.max(limit, 10), 1000);

    // 并行拉全量实体/三元组（均排除 embedding 大字段）；
    // 当前库规模（单文档 <=20 实体）下全量内存聚合足够，无需 SQL 分组
    const [entityRows, tripleRows] = await Promise.all([
      this.entityRepo.find({
        select: ['documentId', 'key', 'name', 'type', 'aliases'],
      }),
      this.tripleRepo.find({
        select: ['documentId', 'head', 'relation', 'tail'],
      }),
    ]);

    // ---------- 节点聚合（key 口径与 buildIndex registerKey 一致） ----------
    const nodeByKey = new Map<string, AggNodeState>();
    for (const row of entityRows) {
      const key = normEntity(row.name) || row.key;
      let state = nodeByKey.get(key);
      if (!state) {
        state = {
          key,
          label: row.name,
          type: row.type,
          aliases: new Set(),
          docIds: new Set(),
          degree: 0,
        };
        nodeByKey.set(key, state);
      }
      // type 首个非 unknown 值优先（unknown 是抽取 schema 的兜底类型）
      if (state.type === 'unknown' && row.type !== 'unknown') {
        state.type = row.type;
      }
      for (const alias of row.aliases ?? []) {
        if (state.aliases.size < MAX_NODE_ALIASES) state.aliases.add(alias);
      }
      state.docIds.add(row.documentId);
    }

    // ---------- 边聚合（端点归一 + 无向对合并，展示方向取首现） ----------
    const edgeStates: AggEdgeState[] = [];
    const edgeByPair = new Map<string, AggEdgeState>();
    for (const row of tripleRows) {
      const head = normEntity(row.head);
      const tail = normEntity(row.tail);
      if (!head || !tail || head === tail) continue; // 自环无展示价值
      // 无向对合并：A→B 与 B→A 是同一事实的不同表述方向（buildIndex 邻接也是无向）
      const pairKey =
        head < tail
          ? `${head}|${row.relation}|${tail}`
          : `${tail}|${row.relation}|${head}`;
      let edge = edgeByPair.get(pairKey);
      if (!edge) {
        edge = { source: head, target: tail, relation: row.relation, count: 0 };
        edgeByPair.set(pairKey, edge);
        edgeStates.push(edge);
      }
      edge.count += 1;
      const headNode = nodeByKey.get(head);
      const tailNode = nodeByKey.get(tail);
      if (headNode) headNode.degree += 1;
      if (tailNode) tailNode.degree += 1;
    }

    // ---------- 节点截断：hub（docCount>=2）与高连接度优先 ----------
    const allNodes = [...nodeByKey.values()];
    const truncated = allNodes.length > maxNodes;
    const keptStates = truncated
      ? allNodes
          .sort(
            (a, b) =>
              b.docIds.size - a.docIds.size ||
              b.degree - a.degree ||
              a.key.localeCompare(b.key),
          )
          .slice(0, maxNodes)
      : allNodes;
    const keptKeys = new Set(keptStates.map((n) => n.key));

    const nodes: GraphNode[] = keptStates.map((s) => ({
      key: s.key,
      label: s.label,
      type: s.type,
      aliases: [...s.aliases].slice(0, MAX_NODE_ALIASES),
      docIds: [...s.docIds].sort((a, b) => a - b),
      docCount: s.docIds.size,
    }));
    const edges: GraphEdge[] = edgeStates
      .filter((e) => keptKeys.has(e.source) && keptKeys.has(e.target))
      .sort((a, b) => b.count - a.count)
      .map(({ source, target, relation, count }) => ({
        source,
        target,
        relation,
        count,
      }));

    return {
      enabled: config.kg.enabled,
      truncated,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodes,
      edges,
    };
  }

  /**
   * GET /api/kg/graph/document/:documentId
   * 单文档子图：不聚合（一实体行一节点、一三元组行一边）。
   * 三元组端点若无对应实体行（如端点是未入实体表的别名），补 implicit 节点，
   * 保证边不悬空、子图完整。
   */
  @Get('graph/document/:documentId')
  async getDocumentGraph(
    @Param('documentId', ParseIntPipe) documentId: number,
  ): Promise<{
    enabled: boolean;
    documentId: number;
    nodes: DocGraphNode[];
    edges: DocGraphEdge[];
  }> {
    const [entityRows, tripleRows] = await Promise.all([
      this.entityRepo.find({
        select: ['key', 'name', 'type', 'aliases'],
        where: { documentId },
      }),
      this.tripleRepo.find({
        select: ['head', 'relation', 'tail'],
        where: { documentId },
      }),
    ]);

    const nodeByKey = new Map<string, DocGraphNode>();
    for (const row of entityRows) {
      const key = normEntity(row.name) || row.key;
      if (nodeByKey.has(key)) continue; // (documentId,key) 唯一索引兜底，理论不重复
      nodeByKey.set(key, {
        key,
        label: row.name,
        type: row.type,
        aliases: row.aliases ?? [],
      });
    }

    const edges: DocGraphEdge[] = [];
    for (const row of tripleRows) {
      const head = normEntity(row.head);
      const tail = normEntity(row.tail);
      if (!head || !tail || head === tail) continue;
      // 端点缺失补隐式节点：label 用三元组中的原始表述
      this.ensureDocNode(nodeByKey, head, row.head);
      this.ensureDocNode(nodeByKey, tail, row.tail);
      edges.push({ source: head, target: tail, relation: row.relation });
    }

    return {
      enabled: config.kg.enabled,
      documentId,
      nodes: [...nodeByKey.values()],
      edges,
    };
  }

  /**
   * GET /api/kg/stats
   * 面板轻量统计：实体/三元组/文档规模、嵌入覆盖率、top 关系分布、
   * 抽取队列各状态计数、内存索引快照状态（builtAt）。
   */
  @Get('stats')
  async getStats(): Promise<{
    enabled: boolean;
    entities: {
      rows: number;
      distinctKeys: number;
      withEmbedding: number;
      documents: number;
    };
    triples: {
      rows: number;
      topRelations: { relation: string; count: number }[];
    };
    ops: {
      pending: number;
      processing: number;
      completed: number;
      failed: number;
    };
    index: { ready: boolean; builtAt: number | null };
  }> {
    const [
      entityRows,
      distinctKeyRaw,
      withEmbedding,
      docRaw,
      tripleRows,
      relationRaw,
      opRaw,
    ] = await Promise.all([
      this.entityRepo.count(),
      // key 是 MySQL 保留字，raw select 中必须反引号转义（静态 SQL，无注入面）
      this.entityRepo
        .createQueryBuilder('e')
        .select('COUNT(DISTINCT e.`key`)', 'cnt')
        .getRawOne<{ cnt: string | number }>(),
      this.entityRepo.count({ where: { embedding: Not(IsNull()) } }),
      this.entityRepo
        .createQueryBuilder('e')
        .select('COUNT(DISTINCT e.documentId)', 'cnt')
        .getRawOne<{ cnt: string | number }>(),
      this.tripleRepo.count(),
      this.tripleRepo
        .createQueryBuilder('t')
        .select('t.relation', 'relation')
        .addSelect('COUNT(*)', 'count')
        .groupBy('t.relation')
        .orderBy('count', 'DESC')
        .limit(10)
        .getRawMany<{ relation: string; count: string | number }>(),
      this.opRepo
        .createQueryBuilder('o')
        .select('o.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .groupBy('o.status')
        .getRawMany<{ status: string; count: string | number }>(),
    ]);

    const opCounts: Record<string, number> = {};
    for (const row of opRaw) opCounts[row.status] = Number(row.count);
    const snapshot = getKgIndexSnapshot();

    return {
      enabled: config.kg.enabled,
      entities: {
        rows: entityRows,
        distinctKeys: Number(distinctKeyRaw?.cnt ?? 0),
        withEmbedding,
        documents: Number(docRaw?.cnt ?? 0),
      },
      triples: {
        rows: tripleRows,
        topRelations: relationRaw.map((r) => ({
          relation: r.relation,
          count: Number(r.count),
        })),
      },
      ops: {
        pending: opCounts['pending'] ?? 0,
        processing: opCounts['processing'] ?? 0,
        completed: opCounts['completed'] ?? 0,
        failed: opCounts['failed'] ?? 0,
      },
      index: {
        ready: snapshot !== null,
        builtAt: snapshot?.builtAt ?? null,
      },
    };
  }

  /** 单文档子图：端点缺失时补 implicit 节点（type unknown，无别名） */
  private ensureDocNode(
    nodeByKey: Map<string, DocGraphNode>,
    key: string,
    rawLabel: string,
  ): void {
    if (nodeByKey.has(key)) return;
    nodeByKey.set(key, {
      key,
      label: rawLabel,
      type: 'unknown',
      aliases: [],
      implicit: true,
    });
  }
}
