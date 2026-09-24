/**
 * buildContextFromResults 冲突注入逻辑测试
 *
 * 覆盖点：hasConflictingSourceSignals 的判定分支
 * （≥2 文档 + ≥2 文档含修正信号词 → 注入冲突规则；否则只含不可信上下文指令）
 */

import {
  buildContextFromResults,
  buildContextWithSources,
  CONFLICT_RESOLUTION_INSTRUCTION,
  dedupeByNormalizedContent,
} from './rag-service.js';

const meta = (documentId: string) => ({
  chunk_type: 'text',
  documentId,
  source: `${documentId}.md`,
});

describe('buildContextFromResults 冲突注入', () => {
  it('两个不同文档均含修正信号词 → 注入冲突规则', () => {
    const context = buildContextFromResults([
      { content: 'previously reported accuracy was 89% correct', metadata: meta('doc-1') },
      { content: 'updated result: accuracy 96%', metadata: meta('doc-2') },
    ]);
    expect(context).toContain(CONFLICT_RESOLUTION_INSTRUCTION.trim());
  });

  it('两个文档但均无修正信号词 → 不注入冲突规则', () => {
    const context = buildContextFromResults([
      { content: 'plain setup notes for deployment', metadata: meta('doc-1') },
      { content: 'plain checklist for release', metadata: meta('doc-2') },
    ]);
    expect(context).not.toContain(CONFLICT_RESOLUTION_INSTRUCTION.trim());
  });

  it('仅单文档含修正信号词 → 不注入（行文用词不构成跨文档冲突）', () => {
    const context = buildContextFromResults([
      { content: 'previously 89%, runbook unchanged', metadata: meta('doc-1') },
      { content: 'unrelated second document body', metadata: meta('doc-2') },
    ]);
    expect(context).not.toContain(CONFLICT_RESOLUTION_INSTRUCTION.trim());
  });

  it('同一文档的两个块各含信号词 → 不注入（文档内自洽）', () => {
    const context = buildContextFromResults([
      { content: 'first chunk mentions updated flow', metadata: meta('doc-1') },
      { content: 'second chunk mentions revised flow', metadata: meta('doc-1') },
    ]);
    expect(context).not.toContain(CONFLICT_RESOLUTION_INSTRUCTION.trim());
  });

  it('中文修正信号词同样触发', () => {
    const context = buildContextFromResults([
      { content: '准确率此前为 89%', metadata: meta('doc-1') },
      { content: '已更正：准确率为 96%', metadata: meta('doc-2') },
    ]);
    expect(context).toContain(CONFLICT_RESOLUTION_INSTRUCTION.trim());
  });

  it('图片块不参与文档计数', () => {
    const context = buildContextFromResults([
      {
        content: 'updated description',
        metadata: { chunk_type: 'image', documentId: 'img-1', image_path: 'a\\b.png' },
      },
      { content: 'corrected body', metadata: meta('doc-1') },
    ]);
    expect(context).not.toContain(CONFLICT_RESOLUTION_INSTRUCTION.trim());
    // 图片块仍正常转换为 Markdown 图片语法
    expect(context).toContain('【图片 1】');
  });

  it('空结果返回空字符串', () => {
    expect(buildContextFromResults([])).toBe('');
  });

  it('非空结果始终包含不可信上下文指令', () => {
    const context = buildContextFromResults([
      { content: 'plain text', metadata: meta('doc-1') },
    ]);
    expect(context).toContain('不可信上下文');
  });
});

describe('buildContextFromResults 文档分组', () => {
  it('同一文档的多个块合并到同一【文档 N】标题下', () => {
    const context = buildContextFromResults([
      { content: 'alpha section body', metadata: meta('doc-1') },
      { content: 'beta section body', metadata: meta('doc-1') },
      { content: 'gamma section body', metadata: meta('doc-2') },
    ]);
    expect(context).toContain('【文档 1】\nalpha section body\n\nbeta section body');
    expect(context).toContain('【文档 2】\ngamma section body');
    // 分组后只有 2 个文档头，不存在第二个 doc-1 的独立头
    expect(context.match(/【文档 \d+】/g)).toHaveLength(2);
  });

  it('分组保持首次出现的排序位置（同文档块连续渲染在组内）', () => {
    const context = buildContextFromResults([
      { content: 'first doc body', metadata: meta('doc-A') },
      { content: 'second doc body', metadata: meta('doc-B') },
      { content: 'first doc continued', metadata: meta('doc-A') },
    ]);
    const idxA = context.indexOf('【文档 1】');
    const idxB = context.indexOf('【文档 2】');
    const idxA2 = context.indexOf('first doc continued');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxA2).toBeGreaterThan(idxA);
    // doc-A 的两个块连续渲染在【文档 1】组内（整体先于 doc-B 组出现）
    expect(idxA2).toBeLessThan(idxB);
    expect(context.indexOf('first doc body')).toBeGreaterThan(idxA);
  });

  it('图片块不参与文档分组，仍按出现顺序独立编号', () => {
    const context = buildContextFromResults([
      { content: 'text before image', metadata: meta('doc-1') },
      {
        content: 'a chart description',
        metadata: { chunk_type: 'image', documentId: 'img-1', image_path: 'a\\b.png' },
      },
      {
        content: 'another chart',
        metadata: { chunk_type: 'image', documentId: 'img-2', image_path: 'a\\c.png' },
      },
    ]);
    expect(context).toContain('【图片 1】');
    expect(context).toContain('【图片 2】');
    expect(context).toContain('![图片 1]');
    expect(context).toContain('![图片 2]');
  });

  it('分组不影响冲突注入判定（metadata 级检测与展示分组解耦）', () => {
    const context = buildContextFromResults([
      { content: 'previously reported accuracy was 89%', metadata: meta('doc-1') },
      { content: 'updated result: accuracy 96%', metadata: meta('doc-2') },
      { content: 'updated appendix data', metadata: meta('doc-2') },
    ]);
    expect(context).toContain(CONFLICT_RESOLUTION_INSTRUCTION.trim());
  });
});

describe('buildContextWithSources 引用来源映射', () => {
  it('sources 编号与上下文【文档 N】严格同源，且字段取自检索元数据', () => {
    const { context, sources } = buildContextWithSources([
      {
        content: 'first doc body',
        metadata: { ...meta('doc-A'), documentTitle: '文档A标题' },
      },
      {
        content: 'second doc body',
        metadata: { ...meta('doc-B'), documentTitle: '文档B标题' },
      },
    ]);
    expect(sources.map((s) => s.index)).toEqual([1, 2]);
    expect(sources.map((s) => s.documentId)).toEqual(['doc-A', 'doc-B']);
    expect(sources.map((s) => s.title)).toEqual(['文档A标题', '文档B标题']);
    expect(context).toContain('【文档 1】');
    expect(context).toContain('【文档 2】');
  });

  it('元数据缺 documentId 与 source 时退化为 rag-{编号} 占位（不得为空串）', () => {
    // 空串会被 CitationItemSchema（documentId 要求 min(1)）拒绝，
    // 导致该条引用被丢弃 —— 前端表现为角标在但悬停无来源卡片、末尾参考文档空白
    const { sources } = buildContextWithSources([
      { content: 'body without ids', metadata: { chunk_type: 'text' } },
    ]);
    expect(sources).toHaveLength(1);
    expect(sources[0].documentId).toBe('rag-1');
    expect(sources[0].title).toBe('文档 1');
  });

  it('图片块不占用文档编号（sources 只含文本组）', () => {
    const { sources } = buildContextWithSources([
      {
        content: 'a chart description',
        metadata: {
          chunk_type: 'image',
          documentId: 'img-1',
          image_path: 'a\\b.png',
        },
      },
      { content: 'text body', metadata: meta('doc-1') },
    ]);
    expect(sources).toHaveLength(1);
    expect(sources[0].index).toBe(1);
    expect(sources[0].documentId).toBe('doc-1');
  });
});

describe('buildContextWithSources 跨轮编号统一（FC 多轮工具调用）', () => {
  it('startDocIndex 让本轮新文档接续全局编号，不从 1 重新开始', () => {
    // FC 模式下 search_knowledge_base 被多轮调用；若每轮独立编号，
    // 模型在第 2 轮看到的【文档 1】与第 1 轮的【文档 1】是不同文档 → 标注张冠李戴
    const { context, sources } = buildContextWithSources(
      [{ content: 'round2 body', metadata: meta('doc-C') }],
      { startDocIndex: 3 },
    );
    expect(sources.map((s) => s.index)).toEqual([3]);
    expect(context).toContain('【文档 3】');
    expect(context).not.toContain('【文档 1】');
  });

  it('knownDocIndex 命中时复用旧编号，且不重复产出 source', () => {
    const known = new Map<string, number>([['doc-A', 1]]);
    const { context, sources } = buildContextWithSources(
      [{ content: 'same doc again', metadata: meta('doc-A') }],
      { startDocIndex: 2, knownDocIndex: known },
    );
    expect(context).toContain('【文档 1】');
    expect(sources).toHaveLength(0);
  });

  it('多轮累积：重复文档复用编号、新文档续编，knownDocIndex 被写回', () => {
    const known = new Map<string, number>();
    const round1 = buildContextWithSources(
      [
        { content: 'A body', metadata: meta('doc-A') },
        { content: 'B body', metadata: meta('doc-B') },
      ],
      { startDocIndex: 1, knownDocIndex: known },
    );
    expect(round1.sources.map((s) => s.index)).toEqual([1, 2]);

    // 第 2 轮：B 已出现过（应复用 2），C 是新文档（应续编 3）
    const round2 = buildContextWithSources(
      [
        { content: 'B body again', metadata: meta('doc-B') },
        { content: 'C body', metadata: meta('doc-C') },
      ],
      { startDocIndex: round1.sources.length + 1, knownDocIndex: known },
    );
    expect(round2.context).toContain('【文档 2】');
    expect(round2.context).toContain('【文档 3】');
    expect(round2.sources.map((s) => s.index)).toEqual([3]);
    expect([...known.entries()].sort()).toEqual([
      ['doc-A', 1],
      ['doc-B', 2],
      ['doc-C', 3],
    ]);
  });

  it('同一文档的多个块仍合并到同一编号（分组优先于跨轮续编）', () => {
    const { context, sources } = buildContextWithSources(
      [
        { content: 'chunk one', metadata: meta('doc-A') },
        { content: 'chunk two', metadata: meta('doc-A') },
      ],
      { startDocIndex: 5, knownDocIndex: new Map() },
    );
    expect(sources).toHaveLength(1);
    expect(sources[0].index).toBe(5);
    expect(context.match(/【文档 \d+】/g)).toEqual(['【文档 5】']);
    expect(context).toContain('chunk one\n\nchunk two');
  });

  it('不传 options 时行为与单轮构建完全一致（RAG 注入路径不受影响）', () => {
    const input = [
      { content: 'A body', metadata: meta('doc-A') },
      { content: 'B body', metadata: meta('doc-B') },
    ];
    expect(buildContextWithSources(input)).toEqual(
      buildContextWithSources(input, {
        startDocIndex: 1,
        knownDocIndex: new Map(),
      }),
    );
  });
});

describe('dedupeByNormalizedContent', () => {
  it('相同内容仅保留先出现的一条，保持原有顺序', () => {
    const input = [
      { content: 'parent body A', score: 0.9 },
      { content: 'parent body B', score: 0.8 },
      { content: 'parent body A', score: 0.7 },
    ];
    const output = dedupeByNormalizedContent(input);
    expect(output).toHaveLength(2);
    expect(output[0].content).toBe('parent body A');
    expect(output[1].content).toBe('parent body B');
  });

  it('仅空白差异的内容视为重复（内部换行/多空格折叠）', () => {
    const input = [
      { content: 'line one\nline two', score: 0.9 },
      { content: 'line one\n\n  line two  ', score: 0.8 },
    ];
    expect(dedupeByNormalizedContent(input)).toHaveLength(1);
  });

  it('不同内容全部保留且不重排', () => {
    const input = [
      { content: 'alpha', score: 0.3 },
      { content: 'beta', score: 0.2 },
    ];
    const output = dedupeByNormalizedContent(input);
    expect(output).toHaveLength(2);
    expect(output[0].content).toBe('alpha');
    expect(output[1].content).toBe('beta');
  });

  it('空数组返回空数组', () => {
    expect(dedupeByNormalizedContent([])).toEqual([]);
  });
});
