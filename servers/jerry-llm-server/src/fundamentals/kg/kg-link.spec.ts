/**
 * KG 在线链路纯函数单元测试（a5）
 *
 * 覆盖 30 题门闩验证（kg-link-spike v2）移植过来的在线口径：
 * 图补充位融合公式（基线优先 + 末尾 slots 个槽位 + topK 截断）、
 * 基线文档 id 归集（数字/字符串对齐）、免 LLM 精确通道匹配、
 * 链接确认提示词结构（provenance 三档 + 校准说明 + 输出格式）、
 * 以及降级守卫（KG 关闭 / 空基线一律不补充）。
 * 任何口径改动都应先让这里的断言失败。
 */

import { config } from '../config.js';
import { buildIndex } from './kg-index.js';
import type { DocEntityRow } from './kg-index.js';
import {
  buildLinkPrompt,
  collectBaselineDocIds,
  exactMatchKeys,
  fuseGraphSupplements,
  resolveGraphSupplements,
} from './kg-link.js';

// ==================== 测试夹具 ====================

function fixtureRows(): DocEntityRow[] {
  return [
    {
      documentId: '101',
      entities: [
        { name: 'NVIDIA H200', type: 'product', aliases: ['H200'] },
        { name: 'eu-central-1', type: 'location', aliases: ['EU Central'] },
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

/** buildLinkPrompt 第二参的结构化夹具（类型直接取自函数签名，避免重复声明内部类型） */
function linkFixture(): Parameters<typeof buildLinkPrompt>[1] {
  return [
    {
      mentionId: 'M1',
      surface: '那款旗舰训练卡',
      variants: ['H200', 'NVIDIA H200'],
      exactKeys: ['h200'],
      candidates: [
        {
          id: 'c1',
          key: 'nvidia h200',
          label: 'NVIDIA H200',
          type: 'product',
          docCount: 3,
          score: 1,
          source: 'both',
          sim: 0.83,
        },
        {
          id: 'c2',
          key: 'training cluster',
          label: 'Training Cluster',
          type: 'project',
          docCount: 1,
          score: 0.6,
          source: 'lexical',
        },
      ],
      linkedKeys: [],
      linkDetails: [],
    },
    {
      mentionId: 'M2',
      surface: '欧洲机房',
      variants: [],
      exactKeys: [],
      candidates: [
        {
          id: 'c3',
          key: 'eu-central-1',
          label: 'eu-central-1',
          type: 'location',
          docCount: 2,
          score: 0.5,
          source: 'semantic',
          sim: 0.7,
        },
      ],
      linkedKeys: [],
      linkDetails: [],
    },
  ];
}

// ==================== fuseGraphSupplements：门闩融合公式 ====================

describe('fuseGraphSupplements', () => {
  const originalSlots = config.kg.supplementSlots;
  afterEach(() => {
    config.kg.supplementSlots = originalSlots;
  });

  it('slots=1：基线保留 topK-1 条，末尾追加 1 条补充块，总条数不变', () => {
    config.kg.supplementSlots = 1;
    const baseline = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
    const merged = fuseGraphSupplements(baseline, ['s1'], 6);
    expect(merged).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 's1']);
  });

  it('slots=2：补充块多于槽位时只取前 slots 条', () => {
    config.kg.supplementSlots = 2;
    const baseline = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
    const merged = fuseGraphSupplements(baseline, ['s1', 's2', 's3'], 6);
    expect(merged).toEqual(['b1', 'b2', 'b3', 'b4', 's1', 's2']);
  });

  it('补充块不足 slots 时按实际条数占位，不硬凑', () => {
    config.kg.supplementSlots = 3;
    const merged = fuseGraphSupplements(['b1', 'b2', 'b3'], ['s1'], 3);
    expect(merged).toEqual(['b1', 'b2', 's1']);
  });

  it('无补充块 / slots=0 时原样返回基线（纯基线降级路径）', () => {
    config.kg.supplementSlots = 1;
    const baseline = ['b1', 'b2', 'b3'];
    expect(fuseGraphSupplements(baseline, [], 3)).toBe(baseline);

    config.kg.supplementSlots = 0;
    expect(fuseGraphSupplements(baseline, ['s1'], 3)).toBe(baseline);
  });

  it('topK <= 0 时原样返回基线，不做任何截断', () => {
    config.kg.supplementSlots = 1;
    const baseline = ['b1', 'b2'];
    expect(fuseGraphSupplements(baseline, ['s1'], 0)).toBe(baseline);
    expect(fuseGraphSupplements(baseline, ['s1'], -1)).toBe(baseline);
  });

  it('基线短于 keepCount 时不填充，末尾仍按 topK 截断', () => {
    config.kg.supplementSlots = 1;
    expect(fuseGraphSupplements(['b1'], ['s1', 's2'], 3)).toEqual(['b1', 's1']);
  });

  it('slots >= topK 时基线全部让位给补充块（keepCount 归零下界）', () => {
    config.kg.supplementSlots = 2;
    expect(fuseGraphSupplements(['b1', 'b2'], ['s1', 's2'], 2)).toEqual([
      's1',
      's2',
    ]);
  });

  it('纯函数：不改动入参数组', () => {
    config.kg.supplementSlots = 1;
    const baseline = ['b1', 'b2', 'b3'];
    const supplements = ['s1'];
    fuseGraphSupplements(baseline, supplements, 3);
    expect(baseline).toEqual(['b1', 'b2', 'b3']);
    expect(supplements).toEqual(['s1']);
  });

  it('对元素形态无感知（两条链路各自的补充块映射都能融合）', () => {
    config.kg.supplementSlots = 1;
    const baseline = [
      { content: 'b1', metadata: { documentId: 1 }, score: 0.9 },
      { content: 'b2', metadata: { documentId: 2 }, score: 0.8 },
    ];
    const merged = fuseGraphSupplements(
      baseline,
      [{ content: 's1', metadata: { documentId: 3 }, score: 0.7 }],
      2,
    );
    expect(merged.map((r) => r.content)).toEqual(['b1', 's1']);
  });
});

// ==================== collectBaselineDocIds：chunk → doc 对齐 ====================

describe('collectBaselineDocIds', () => {
  it('数字与字符串 documentId 归一为字符串并去重（与索引 keyToDocs 对齐）', () => {
    const ids = collectBaselineDocIds([
      { metadata: { documentId: 101 } },
      { metadata: { documentId: '101' } },
      { metadata: { documentId: 202 } },
    ]);
    expect(ids).toEqual(['101', '202']);
  });

  it('metadata 缺失 / 为 null / 无 documentId 时跳过', () => {
    expect(
      collectBaselineDocIds([
        {},
        { metadata: null },
        { metadata: {} },
        { metadata: { documentId: null } },
      ]),
    ).toEqual([]);
  });

  it('保持首次出现顺序（融合时基线优先级依据）', () => {
    expect(
      collectBaselineDocIds([
        { metadata: { documentId: '3' } },
        { metadata: { documentId: '1' } },
        { metadata: { documentId: '3' } },
        { metadata: { documentId: '2' } },
      ]),
    ).toEqual(['3', '1', '2']);
  });

  it('空基线返回空数组', () => {
    expect(collectBaselineDocIds([])).toEqual([]);
  });
});

// ==================== exactMatchKeys：免 LLM 精确通道 ====================

describe('exactMatchKeys', () => {
  const index = buildIndex(fixtureRows());

  it('surface 归一化后命中实体键（大小写/空白不敏感）', () => {
    expect(
      exactMatchKeys({ surface: '  NVIDIA   H200 ', variants: [] }, index),
    ).toEqual(['nvidia h200']);
  });

  it('variants 命中别名键', () => {
    expect(
      exactMatchKeys({ surface: '那款旗舰训练卡', variants: ['H200'] }, index),
    ).toEqual(['h200']);
  });

  it('surface 与 variant 归一化到同一键时去重', () => {
    expect(
      exactMatchKeys(
        { surface: 'NVIDIA H200', variants: ['nvidia h200', 'H200'] },
        index,
      ),
    ).toEqual(['nvidia h200', 'h200']);
  });

  it('空字符串形态不产出键，未命中返回空数组', () => {
    expect(exactMatchKeys({ surface: '', variants: ['   '] }, index)).toEqual(
      [],
    );
    expect(
      exactMatchKeys({ surface: '不存在的实体', variants: [] }, index),
    ).toEqual([]);
  });
});

// ==================== buildLinkPrompt：链接确认提示词口径 ====================

describe('buildLinkPrompt', () => {
  const prompt = buildLinkPrompt(
    '那款旗舰训练卡部署在哪个欧洲机房？',
    linkFixture(),
  );

  it('包含问题原文与三档 matchType 定义', () => {
    expect(prompt).toContain('Question: 那款旗舰训练卡部署在哪个欧洲机房？');
    expect(prompt).toContain('"matchType": "exact"');
    expect(prompt).toContain('"variant"');
    expect(prompt).toContain('"related" (associated but NOT the same entity');
  });

  it('包含校准说明与「宁可低置信度也不要漏」的指示', () => {
    expect(prompt).toContain('Calibration: 0.9+ = clearly the same entity');
    expect(prompt).toContain(
      'Prefer emitting a low-confidence link over omitting it',
    );
  });

  it('逐 mention 列出 surface / variants，variants 为空时不追加括号', () => {
    expect(prompt).toContain(
      'M1 surface: "那款旗舰训练卡" (variants: H200, NVIDIA H200)',
    );
    expect(prompt).toContain('M2 surface: "欧洲机房"');
    expect(prompt).not.toContain('M2 surface: "欧洲机房" (variants');
  });

  it('候选行含 label / type / docs，并按来源标注 provenance', () => {
    expect(prompt).toContain(
      'c1: "NVIDIA H200" (type=product, docs=3, via=lexical+semantic sim=0.83)',
    );
    expect(prompt).toContain(
      'c2: "Training Cluster" (type=project, docs=1, via=lexical)',
    );
    // 语义相似度固定两位小数（0.7 → 0.70），口径与 spike 一致
    expect(prompt).toContain(
      'c3: "eu-central-1" (type=location, docs=2, via=semantic sim=0.70)',
    );
  });

  it('结尾固定 JSON 输出格式（禁止 markdown 围栏）', () => {
    expect(prompt).toContain('Output ONLY a JSON object, no markdown fences:');
    expect(prompt).toContain(
      '{"decisions":[{"mention":"M1","links":[{"candidate":"c1","confidence":0.95,"matchType":"exact"}',
    );
    expect(prompt.trimEnd().endsWith('"matchType":"variant"}]}]}')).toBe(true);
  });

  it('无可链接 mention 时只保留说明与输出格式（调用方已提前短路，此为兜底形态）', () => {
    const empty = buildLinkPrompt('空问题', []);
    expect(empty).toContain('Question: 空问题');
    expect(empty).toContain('Output ONLY a JSON object');
    expect(empty).not.toContain('M1 surface');
  });
});

// ==================== resolveGraphSupplements：降级守卫 ====================

describe('resolveGraphSupplements', () => {
  const originalEnabled = config.kg.enabled;
  const originalSlots = config.kg.supplementSlots;
  afterEach(() => {
    config.kg.enabled = originalEnabled;
    config.kg.supplementSlots = originalSlots;
  });

  it('KG 关闭时直接返回空数组，不触发任何链接调用', async () => {
    config.kg.enabled = false;
    config.kg.supplementSlots = 1;
    await expect(
      resolveGraphSupplements('NVIDIA H200 部署在哪', ['101']),
    ).resolves.toEqual([]);
  });

  it('supplementSlots=0 时直接返回空数组（补充位关闭）', async () => {
    config.kg.enabled = true;
    config.kg.supplementSlots = 0;
    await expect(
      resolveGraphSupplements('NVIDIA H200 部署在哪', ['101']),
    ).resolves.toEqual([]);
  });

  it('基线为空时不补充（无相似度关联的查询不注入图扩展内容）', async () => {
    config.kg.enabled = true;
    config.kg.supplementSlots = 1;
    await expect(
      resolveGraphSupplements('NVIDIA H200 部署在哪', []),
    ).resolves.toEqual([]);
  });

  it('索引未加载时降级为空数组，不抛错', async () => {
    config.kg.enabled = true;
    config.kg.supplementSlots = 1;
    // 未调用 setKgIndexSnapshot：linkQueryToEntities 拿不到快照返回 null
    await expect(
      resolveGraphSupplements('NVIDIA H200 部署在哪', ['101']),
    ).resolves.toEqual([]);
  });
});
