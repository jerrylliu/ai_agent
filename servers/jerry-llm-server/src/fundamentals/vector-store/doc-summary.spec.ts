/**
 * Doc Tree v1 — 文档摘要节点单测（纯函数部分）
 *
 * 覆盖：
 *   - truncateSummarySource：短文不截断 / 超长截断带省略标记 / 空白压缩
 *   - extractiveSummaryFallback：空正文回退标题 / 标题去重拼接 / 长文截断 / 长度上限
 *   - buildSummaryChunkMetadata：哨兵字段（chunk_index=-1 / chunk_role）与 hash 一致性
 *
 * LLM 生成与 ChromaDB/BM25 写入路径依赖外部设施，不在单测覆盖范围
 *（与 vector-crud-dedup.spec.ts 的覆盖边界一致）。
 */
import {
  truncateSummarySource,
  extractiveSummaryFallback,
  buildSummaryChunkMetadata,
  SUMMARY_SOURCE_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  EXTRACTIVE_FALLBACK_CHARS,
} from './doc-summary';
import { computeChunkHash } from './vector-crud';

describe('DocSummary 纯函数', () => {
  // ==================== truncateSummarySource ====================
  describe('truncateSummarySource', () => {
    it('短文不截断，且压缩多余空白', () => {
      const result = truncateSummarySource('  a \n\n b  \t c  ', 100);
      expect(result).toBe('a b c');
    });

    it('超长截断并带省略标记', () => {
      const text = 'x'.repeat(SUMMARY_SOURCE_MAX_CHARS + 100);
      const result = truncateSummarySource(text, SUMMARY_SOURCE_MAX_CHARS);
      expect(result.length).toBeLessThanOrEqual(SUMMARY_SOURCE_MAX_CHARS + 20);
      expect(result).toContain('【后文因超长已省略】');
    });

    it('恰好等于上限时不截断', () => {
      const text = 'y'.repeat(SUMMARY_SOURCE_MAX_CHARS);
      const result = truncateSummarySource(text, SUMMARY_SOURCE_MAX_CHARS);
      expect(result).toBe(text);
    });
  });

  // ==================== extractiveSummaryFallback ====================
  describe('extractiveSummaryFallback', () => {
    it('空正文 → 回退为标题', () => {
      expect(extractiveSummaryFallback('部署手册', '   \n\t  ')).toBe(
        '部署手册',
      );
    });

    it('正文以标题开头时不重复拼接标题', () => {
      const text = '部署手册：第一章 环境准备';
      const result = extractiveSummaryFallback('部署手册', text);
      expect(result).not.toContain('部署手册：部署手册');
      expect(result).toBe(text);
    });

    it('正文不含标题时拼接「标题：」前缀', () => {
      const result = extractiveSummaryFallback('标题A', '正文内容B');
      expect(result).toBe('标题A：正文内容B');
    });

    it('长文正文截断并追加省略号', () => {
      const body = 'z'.repeat(EXTRACTIVE_FALLBACK_CHARS + 500);
      const result = extractiveSummaryFallback('标题', body);
      expect(result).toContain('…');
      // 总长不超过 SUMMARY_MAX_CHARS
      expect(result.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    });

    it('压缩空白后再截断', () => {
      const body = `a${' \n'.repeat(300)}b`;
      const result = extractiveSummaryFallback('', body);
      expect(result).toBe('a b');
    });
  });

  // ==================== buildSummaryChunkMetadata ====================
  describe('buildSummaryChunkMetadata', () => {
    const base = {
      documentId: '42',
      documentTitle: '测试文档',
      versionId: '7',
      versionStatus: 'active',
      source: 'test.txt',
      fileType: '.txt',
    };

    it('携带哨兵字段：chunk_index=-1 / chunk_role=summary / doc_type=summary', () => {
      const meta = buildSummaryChunkMetadata(base, '摘要内容');
      expect(meta.chunk_index).toBe(-1);
      expect(meta.chunk_role).toBe('summary');
      expect(meta.doc_type).toBe('summary');
    });

    it('继承 baseMetadata 全部字段（版本过滤/删除联动依赖）', () => {
      const meta = buildSummaryChunkMetadata(base, '摘要内容');
      expect(meta.documentId).toBe('42');
      expect(meta.versionId).toBe('7');
      expect(meta.versionStatus).toBe('active');
      expect(meta.source).toBe('test.txt');
      expect(meta.fileType).toBe('.txt');
    });

    it('chunk_hash 与 computeChunkHash(摘要) 一致（幂等键同源）', () => {
      const summary = '这是摘要正文';
      const meta = buildSummaryChunkMetadata(base, summary);
      expect(meta.chunk_hash).toBe(computeChunkHash(summary));
    });

    it('baseMetadata 与摘要同名字段不存在冲突（摘要不写入 metadata 正文）', () => {
      // 摘要正文只进 pageContent，metadata 中不得出现 content/pageContent 键
      const meta = buildSummaryChunkMetadata(base, '摘要内容');
      expect(meta.content).toBeUndefined();
      expect(meta.pageContent).toBeUndefined();
    });
  });
});
