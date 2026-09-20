/**
 * buildContextFromResults 冲突注入逻辑测试
 *
 * 覆盖点：hasConflictingSourceSignals 的判定分支
 * （≥2 文档 + ≥2 文档含修正信号词 → 注入冲突规则；否则只含不可信上下文指令）
 */

import {
  buildContextFromResults,
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
