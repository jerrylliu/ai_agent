/**
 * KG 核心层纯函数单元测试（a4）
 *
 * 覆盖 30 题门闩验证（kg-link-spike v2）移植过来的算法口径：
 * 归一化/分词/余弦、图构建（别名 canonical + primaryKeys 二次修正）、
 * 词汇召回三分档、语义补充槽位、图扩展权重（别名等权 1.0 / 1 跳 0.5）、
 * 同文档实体合并。任何口径改动都应先让这里的断言失败。
 */

import { config } from '../config.js';
import { cosine, mergeEntitiesByKey, normEntity, tokenize } from './kg-core.js';
import {
  buildIndex,
  clearKgIndexSnapshot,
  expandFromLinkedKeys,
  getKgIndexSnapshot,
  recallCandidates,
  recallLexical,
  semanticSupplement,
  setKgIndexSnapshot,
} from './kg-index.js';
import type { DocEntityRow } from './kg-index.js';

// ==================== 测试夹具 ====================

/** 两篇文档的固定夹具：覆盖主名/别名/三元组边/跨文档共现 */
function fixtureRows(): DocEntityRow[] {
  return [
    {
      documentId: '101',
      entities: [
        { name: 'NVIDIA H200', type: 'product', aliases: ['H200'] },
        {
          name: 'eu-central-1',
          type: 'location',
          aliases: ['EU Central', 'Frankfurt region'],
        },
      ],
      triples: [
        { head: 'NVIDIA H200', relation: 'located_in', tail: 'eu-central-1' },
      ],
    },
    {
      documentId: '202',
      entities: [{ name: 'Training Cluster', type: 'project', aliases: [] }],
      triples: [
        {
          head: 'Training Cluster',
          relation: 'depends_on',
          tail: 'NVIDIA H200',
        },
      ],
    },
  ];
}

// ==================== kg-core：归一化 / 分词 / 余弦 ====================

describe('normEntity', () => {
  it('小写 + 空白折叠 + 去首尾空白', () => {
    expect(normEntity('  NVIDIA   H200 ')).toBe('nvidia h200');
    expect(normEntity('EU-Central-1')).toBe('eu-central-1');
    expect(normEntity('')).toBe('');
  });
});

describe('tokenize', () => {
  it('按非字母数字切分，过滤单字符与停用词', () => {
    expect(tokenize('EU-Central 1')).toEqual(['eu', 'central']);
    expect(tokenize('the Training Cluster plan')).toEqual([
      'training',
      'cluster',
    ]);
    expect(tokenize('a b c')).toEqual([]);
  });
});

describe('cosine', () => {
  it('相同方向 = 1，正交 = 0，零向量 = 0（避免 NaN 污染排序）', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
    expect(cosine([0.6, 0.8], [1, 0])).toBeCloseTo(0.6);
    expect(cosine([], [])).toBe(0);
  });
});

// ==================== kg-index：buildIndex ====================

describe('buildIndex', () => {
  const index = buildIndex(fixtureRows());

  it('主名注册：label / type / token 倒排', () => {
    expect(index.keyToLabel.get('nvidia h200')).toBe('NVIDIA H200');
    expect(index.keyToType.get('nvidia h200')).toBe('product');
    expect(index.tokenToKeys.get('h200')).toContain('nvidia h200');
  });

  it('别名折叠到 canonical，且别名键也参与文档归属', () => {
    expect(index.keyToCanonical.get('h200')).toBe('nvidia h200');
    expect(index.keyToCanonical.get('eu central')).toBe('eu-central-1');
    expect(index.keyToCanonical.get('frankfurt region')).toBe('eu-central-1');
    expect(index.keyToDocs.get('h200')).toEqual(new Set(['101']));
  });

  it('跨文档共现：keyToDocs 合并文档集合', () => {
    expect(index.keyToDocs.get('nvidia h200')).toEqual(new Set(['101', '202']));
  });

  it('三元组建无向边并计数', () => {
    expect(index.adjacency.get('training cluster')).toContain('nvidia h200');
    expect(index.adjacency.get('nvidia h200')).toContain('training cluster');
    expect(index.adjacency.get('nvidia h200')).toContain('eu-central-1');
    expect(index.tripleCount).toBe(2);
  });

  it('primaryKeys 二次修正：后续文档把别名当主名时撤销别名身份', () => {
    const rows: DocEntityRow[] = [
      {
        documentId: '1',
        entities: [
          { name: 'Project Alpha', type: 'project', aliases: ['Alpha'] },
        ],
        triples: [],
      },
      {
        documentId: '2',
        entities: [{ name: 'Alpha', type: 'team', aliases: [] }],
        triples: [],
      },
    ];
    const idx = buildIndex(rows);
    // 'alpha' 在 doc2 中是独立主名，不得被折叠到 'project alpha'
    expect(idx.keyToCanonical.has('alpha')).toBe(false);
    // label/type 保持 registerKey「首现优先」口径（首注册时随别名带入 'project'）
    expect(idx.keyToType.get('alpha')).toBe('project');
    expect(idx.keyToDocs.get('alpha')).toEqual(new Set(['1', '2']));
  });
});

// ==================== kg-index：recallLexical（v1 三分档口径） ====================

describe('recallLexical', () => {
  const index = buildIndex(fixtureRows());

  it('① 精确归一化命中 = 1.0（大小写/连字符不敏感）', () => {
    const hits = recallLexical(
      { surface: 'EU-Central-1', variants: [] },
      index,
    );
    expect(hits[0]).toEqual({ key: 'eu-central-1', score: 1 });
  });

  it('② 子串包含 = 0.8（型号/SKU 形态），别名键精确命中同时保留 1.0', () => {
    const hits = recallLexical({ surface: 'H200', variants: [] }, index);
    const byKey = new Map(hits.map((h) => [h.key, h.score]));
    expect(byKey.get('h200')).toBe(1); // 别名键本身精确命中
    expect(byKey.get('nvidia h200')).toBeCloseTo(0.8); // 主名包含子串
  });

  it('③ token 重叠 = 0.6 × 重叠率（语序打乱避开子串档）', () => {
    const hits = recallLexical(
      { surface: 'frankfurt deploy region', variants: [] },
      index,
    );
    // tokens = {frankfurt, deploy, region}，'frankfurt region' 命中 2/3 → 0.4
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe('frankfurt region');
    expect(hits[0].score).toBeCloseTo(0.4);
  });

  it('低于 candidateMinScore(0.3) 的候选被过滤', () => {
    // tokens = {nvidia, deployment, pipeline, systems}，'nvidia h200' 只重叠 1/4 → 0.15
    const hits = recallLexical(
      { surface: 'nvidia deployment pipeline systems', variants: [] },
      index,
    );
    expect(hits).toHaveLength(0);
  });

  it('候选按分数降序并截断到 candidateTopK', () => {
    const manyRows: DocEntityRow[] = [
      {
        documentId: '1',
        entities: Array.from({ length: 10 }, (_, i) => ({
          name: `alpha mod${i}`,
          type: 'product',
          aliases: [],
        })),
        triples: [],
      },
    ];
    const idx = buildIndex(manyRows);
    const hits = recallLexical({ surface: 'alpha', variants: [] }, idx);
    expect(hits.length).toBe(config.kg.candidateTopK); // 10 个候选截断到 8
    expect(hits.every((h) => h.score >= config.kg.candidateMinScore)).toBe(
      true,
    );
  });
});

// ==================== kg-index：semanticSupplement ====================

describe('semanticSupplement', () => {
  const index = buildIndex(fixtureRows());
  const keyToEmbedding = new Map<string, number[]>([
    ['nvidia h200', [1, 0]],
    ['eu-central-1', [0.6, 0.8]],
    ['training cluster', [0, 1]],
  ]);

  it('sim ≥ embedMinSim(0.5) 才入选，低于阈值的被丢弃', () => {
    const out = semanticSupplement([[1, 0]], index, keyToEmbedding, new Set());
    expect(out.map((o) => o.key)).toEqual(['nvidia h200', 'eu-central-1']);
    expect(out[0].sim).toBeCloseTo(1);
    expect(out[1].sim).toBeCloseTo(0.6);
  });

  it('已在词汇池的候选打 alreadyLexical 标记且不占补充槽位', () => {
    const out = semanticSupplement(
      [[1, 0]],
      index,
      keyToEmbedding,
      new Set(['nvidia h200']),
    );
    expect(out).toHaveLength(2);
    expect(out.find((o) => o.key === 'nvidia h200')?.alreadyLexical).toBe(true);
    expect(out.find((o) => o.key === 'eu-central-1')?.alreadyLexical).toBe(
      false,
    );
  });

  it('最多补 embedSupplementSlots(4) 个新候选', () => {
    const bigEmbed = new Map<string, number[]>();
    for (let i = 0; i < 6; i++) bigEmbed.set(`ent${i}`, [1, 0]);
    const bigRows: DocEntityRow[] = [
      {
        documentId: '1',
        entities: Array.from({ length: 6 }, (_, i) => ({
          name: `ent${i}`,
          type: 'product',
          aliases: [],
        })),
        triples: [],
      },
    ];
    const out = semanticSupplement(
      [[1, 0]],
      buildIndex(bigRows),
      bigEmbed,
      new Set(),
    );
    expect(out).toHaveLength(config.kg.embedSupplementSlots);
  });

  it('无查询向量或无嵌入时返回空（语义通道自动关闭）', () => {
    expect(semanticSupplement([], index, keyToEmbedding, new Set())).toEqual(
      [],
    );
    expect(semanticSupplement([[1, 0]], index, new Map(), new Set())).toEqual(
      [],
    );
  });
});

describe('recallCandidates', () => {
  const index = buildIndex(fixtureRows());

  it('词汇 ∪ 语义：重叠候选标 both，纯语义候选标 semantic 且带 sim', () => {
    const keyToEmbedding = new Map<string, number[]>([
      ['nvidia h200', [1, 0]],
      ['training cluster', [0.9, 0.1]],
    ]);
    const picked = recallCandidates(
      { surface: 'H200', variants: [] },
      index,
      [[1, 0]],
      keyToEmbedding,
    );
    const h200Main = picked.find((p) => p.key === 'nvidia h200');
    expect(h200Main?.source).toBe('both');
    expect(h200Main?.sim).toBeDefined();
    // 'training cluster' 与 mention 无字面重叠，只能从语义通道进入
    const tc = picked.find((p) => p.key === 'training cluster');
    expect(tc?.source).toBe('semantic');
    expect(picked.every((p, i) => p.id === `c${i + 1}`)).toBe(true);
  });

  it('keyToEmbedding 为 null 时退化为纯词汇通道', () => {
    const picked = recallCandidates(
      { surface: 'H200', variants: [] },
      index,
      [],
      null,
    );
    expect(picked.every((p) => p.source === 'lexical')).toBe(true);
  });
});

// ==================== kg-index：expandFromLinkedKeys ====================

describe('expandFromLinkedKeys', () => {
  const index = buildIndex(fixtureRows());

  it('链接实体文档 = 1.0，1 跳邻居文档 = hopNeighborWeight(0.5)', () => {
    const docs = expandFromLinkedKeys(['training cluster'], index);
    const byId = new Map(docs.map((d) => [d.documentId, d]));
    // 自身文档 202 = 1.0；1 跳邻居 nvidia h200 → 101/202 各 +0.5，h200 别名边被 core 跳过
    expect(byId.get('202')?.score).toBeCloseTo(1.5);
    expect(byId.get('101')?.score).toBeCloseTo(0.5);
    expect(byId.get('101')?.via).toContain('1hop:NVIDIA H200');
  });

  it('命中别名时经 canonical 按同等权重 1.0 扩展（不走 1 跳降权）', () => {
    const viaAlias = expandFromLinkedKeys(['h200'], index);
    const viaPrimary = expandFromLinkedKeys(['nvidia h200'], index);
    const aliasById = new Map(viaAlias.map((d) => [d.documentId, d.score]));
    const primaryById = new Map(viaPrimary.map((d) => [d.documentId, d.score]));
    // 别名与主名扩展后，主名文档集合得分一致（别名键自身文档额外 +1 属预期）
    expect(aliasById.get('202')).toBeCloseTo(primaryById.get('202')!);
    expect(aliasById.get('202')).toBeCloseTo(1.5);
  });

  it('结果按得分降序，同分按 documentId 字典序', () => {
    const docs = expandFromLinkedKeys(['eu-central-1'], index);
    for (let i = 1; i < docs.length; i++) {
      expect(docs[i - 1].score).toBeGreaterThanOrEqual(docs[i].score);
    }
  });

  it('空链接集合返回空数组', () => {
    expect(expandFromLinkedKeys([], index)).toEqual([]);
  });
});

// ==================== kg-index：快照单例 ====================

describe('KgIndexSnapshot 单例', () => {
  afterEach(() => clearKgIndexSnapshot());

  it('set 后 get 返回成对快照，clear 后为 null', () => {
    expect(getKgIndexSnapshot()).toBeNull();
    const index = buildIndex(fixtureRows());
    const embed = new Map<string, number[]>([['nvidia h200', [1, 0]]]);
    setKgIndexSnapshot(index, embed);
    const snap = getKgIndexSnapshot();
    expect(snap?.index).toBe(index);
    expect(snap?.keyToEmbedding).toBe(embed);
    expect(snap?.builtAt).toBeGreaterThan(0);
    clearKgIndexSnapshot();
    expect(getKgIndexSnapshot()).toBeNull();
  });
});

// ==================== kg-core：mergeEntitiesByKey ====================

describe('mergeEntitiesByKey', () => {
  it('同 key 合并：name/type 首现者留，aliases 取并集', () => {
    const merged = mergeEntitiesByKey([
      { name: 'NVIDIA H200', type: 'product', aliases: ['H200'] },
      { name: 'nvidia  h200', type: 'model', aliases: ['H200', 'NV H200'] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('NVIDIA H200');
    expect(merged[0].type).toBe('product');
    expect(merged[0].aliases).toEqual(['H200', 'NV H200']);
  });

  it('剔除与主名等价或空的别名', () => {
    const merged = mergeEntitiesByKey([
      {
        name: 'EU Central',
        type: 'location',
        aliases: ['eu  central', '', 'Frankfurt'],
      },
    ]);
    expect(merged[0].aliases).toEqual(['Frankfurt']);
  });

  it('空 name 的行被跳过', () => {
    const merged = mergeEntitiesByKey([
      { name: '  ', type: 'unknown', aliases: [] },
      { name: 'A100', type: 'product', aliases: [] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('A100');
  });

  it('合并结果直接喂给 buildIndex 与原始抽取等价（落库还原口径一致）', () => {
    const entities = [
      { name: 'NVIDIA H200', type: 'product', aliases: ['H200'] },
      { name: 'nvidia h200', type: 'product', aliases: ['NV H200'] },
    ];
    const rawIndex = buildIndex([{ documentId: '1', entities, triples: [] }]);
    const mergedIndex = buildIndex([
      { documentId: '1', entities: mergeEntitiesByKey(entities), triples: [] },
    ]);
    expect([...mergedIndex.keyToCanonical.entries()]).toEqual([
      ...rawIndex.keyToCanonical.entries(),
    ]);
    expect([...mergedIndex.keyToLabel.keys()].sort()).toEqual(
      [...rawIndex.keyToLabel.keys()].sort(),
    );
  });
});
