/**
 * fundamentals/citations.spec.ts
 *
 * 引用解析纯函数单元测试：标注提取（extractCitationRefs）与
 * 引用解析（resolveCitations）+ zod schema 校验边界。
 * 依赖 zod；logger 已 mock（脏数据跳过分支会记 warn，避免加载真实 winston）。
 */

jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  extractCitationRefs,
  resolveCitations,
  CitationItemSchema,
  CitationsEventSchema,
  type DocSourceEntry,
} from './citations';
import { logger } from './logger';

const SOURCES: DocSourceEntry[] = [
  {
    index: 1,
    documentId: 'doc-a',
    title: '文档A',
    snippet: '文档A的首块内容预览',
  },
  {
    index: 2,
    documentId: 'doc-b',
    title: '文档B',
    snippet: '文档B的首块内容预览',
  },
  {
    index: 3,
    documentId: 'doc-c',
    title: '文档C',
    snippet: '文档C的首块内容预览',
  },
];

describe('extractCitationRefs', () => {
  it('应提取全角括号形态（【文档 X】）的编号', () => {
    expect(extractCitationRefs('依据是某规定（【文档 1】）。')).toEqual([1]);
  });

  it('应提取裸【文档 X】形态的编号', () => {
    expect(extractCitationRefs('依据是某规定【文档 2】。')).toEqual([2]);
  });

  it('应提取同括号内多来源（【文档 1】【文档 3】）的全部编号', () => {
    expect(
      extractCitationRefs('综合两份资料（【文档 1】【文档 3】）可知……'),
    ).toEqual([1, 3]);
  });

  it('同一编号多次出现时按首次出现去重', () => {
    expect(
      extractCitationRefs('（【文档 2】）开头（【文档 2】）结尾（【文档 1】）'),
    ).toEqual([2, 1]);
  });

  it('无任何标注时返回空数组', () => {
    expect(extractCitationRefs('完全没有任何来源标注的回答')).toEqual([]);
  });

  it('不应误匹配【图片 N】编号', () => {
    expect(extractCitationRefs('如下图所示【图片 1】（【文档 1】）')).toEqual([
      1,
    ]);
  });

  it('应容忍编号前的空格变体（【文档  2】）', () => {
    expect(extractCitationRefs('（【文档  2】）')).toEqual([2]);
  });
});

describe('resolveCitations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('有效编号应映射为含 documentId/title/snippet 的引用条目', () => {
    const { citations, invalidRefs } = resolveCitations(
      '答案依据（【文档 1】）。',
      SOURCES,
    );
    expect(invalidRefs).toEqual([]);
    expect(citations).toEqual([
      {
        ref: 1,
        documentId: 'doc-a',
        title: '文档A',
        snippet: '文档A的首块内容预览',
      },
    ]);
  });

  it('模型幻觉编号应收集进 invalidRefs 且不入 citations', () => {
    const { citations, invalidRefs } = resolveCitations(
      '答案依据（【文档 9】）。',
      SOURCES,
    );
    expect(citations).toEqual([]);
    expect(invalidRefs).toEqual([9]);
  });

  it('混合场景：有效与无效编号互不干扰，顺序保持首次标注顺序', () => {
    const { citations, invalidRefs } = resolveCitations(
      '前半依据（【文档 3】），中间幻觉（【文档 7】），后半依据（【文档 1】）。',
      SOURCES,
    );
    expect(citations.map((c) => c.ref)).toEqual([3, 1]);
    expect(invalidRefs).toEqual([7]);
  });

  it('sources 为空时所有编号均为无效（空检索结果不该产生引用）', () => {
    const { citations, invalidRefs } = resolveCitations('（【文档 1】）', []);
    expect(citations).toEqual([]);
    expect(invalidRefs).toEqual([1]);
  });

  it('全文无标注时 citations 与 invalidRefs 均为空（调用方不发 citations 事件）', () => {
    const { citations, invalidRefs } = resolveCitations('无标注回答', SOURCES);
    expect(citations).toEqual([]);
    expect(invalidRefs).toEqual([]);
  });

  it('来源条目 documentId 为空串时应跳过该条并记日志，其余引用照常返回（不抛错）', () => {
    // 真实故障场景：向量库元数据缺 documentId 与 source 时，旧实现兜底空串 →
    // parse 抛 ZodError → 整批引用丢失 + 冒泡跳过 res.end()（前端流挂死）。
    // 现改为单条降级跳过，保证其余引用仍可推送。
    const dirtySources: DocSourceEntry[] = [
      { index: 1, documentId: '', title: '文档A', snippet: '片段A' },
      { index: 2, documentId: 'doc-b', title: '文档B', snippet: '片段B' },
    ];
    let result!: ReturnType<typeof resolveCitations>;
    expect(() => {
      result = resolveCitations('（【文档 1】）与（【文档 2】）', dirtySources);
    }).not.toThrow();

    expect(result.invalidRefs).toEqual([]);
    expect(result.citations).toEqual([
      { ref: 2, documentId: 'doc-b', title: '文档B', snippet: '片段B' },
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // 日志必须带上可定位信息（编号 + 非法字段原因），不得静默吞错
    const meta = (logger.warn as jest.Mock).mock.calls[0][1] as {
      ref: number;
      issues: string[];
    };
    expect(meta.ref).toBe(1);
    expect(meta.issues.join('|')).toContain('documentId');
  });

  it('来源条目 title 为空串时同样跳过该条，不影响其他引用', () => {
    const dirtySources: DocSourceEntry[] = [
      { index: 1, documentId: 'doc-a', title: '', snippet: '片段A' },
      { index: 2, documentId: 'doc-b', title: '文档B', snippet: '片段B' },
    ];
    const { citations } = resolveCitations(
      '（【文档 1】）（【文档 2】）',
      dirtySources,
    );
    expect(citations.map((c) => c.ref)).toEqual([2]);
  });

  it('标注数超过 MAX_CITATIONS 时按出现顺序截断（防 sendCitations 出口校验失败丢弃整批引用）', () => {
    // 构造 25 个来源 + 回答引用全部 25 个编号（FC 多轮检索累计场景，topK 无上限可达）
    const manySources = Array.from({ length: 25 }, (_, i) => ({
      index: i + 1,
      documentId: `doc-${i + 1}`,
      title: `文档${i + 1}`,
      snippet: `片段${i + 1}`,
    }));
    const fullText = Array.from(
      { length: 25 },
      (_, i) => `依据${i + 1}（【文档 ${i + 1}】）。`,
    ).join('');
    const { citations, invalidRefs } = resolveCitations(fullText, manySources);
    expect(citations).toHaveLength(20); // MAX_CITATIONS
    expect(citations[0].ref).toBe(1); // 按出现顺序保留前 20
    expect(citations[19].ref).toBe(20);
    expect(invalidRefs).toEqual([]);
    // 截断后的载荷必须能通过 sendCitations 出口 schema（护栏一致性）
    expect(CitationsEventSchema.safeParse({ citations }).success).toBe(true);
  });
});

describe('CitationItemSchema / CitationsEventSchema', () => {
  it('合法引用条目应通过校验', () => {
    const parsed = CitationItemSchema.safeParse({
      ref: 1,
      documentId: 'doc-a',
      title: '文档A',
      snippet: '片段',
    });
    expect(parsed.success).toBe(true);
  });

  it('ref 小于 1 应被拒绝（编号从 1 起）', () => {
    const parsed = CitationItemSchema.safeParse({
      ref: 0,
      documentId: 'doc-a',
      title: '文档A',
      snippet: '片段',
    });
    expect(parsed.success).toBe(false);
  });

  it('documentId 为空字符串应被拒绝', () => {
    const parsed = CitationItemSchema.safeParse({
      ref: 1,
      documentId: '',
      title: '文档A',
      snippet: '片段',
    });
    expect(parsed.success).toBe(false);
  });

  it('citations 事件载荷超 20 条应被拒绝（出口护栏）', () => {
    const items = Array.from({ length: 21 }, (_, i) => ({
      ref: i + 1,
      documentId: `doc-${i}`,
      title: `文档${i}`,
      snippet: '片段',
    }));
    expect(CitationsEventSchema.safeParse({ citations: items }).success).toBe(
      false,
    );
  });
});
