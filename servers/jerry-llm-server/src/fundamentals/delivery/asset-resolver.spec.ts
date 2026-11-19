/**
 * fundamentals/delivery/asset-resolver.spec.ts
 *
 * 测试 resolveFcAssetFromStores：fc:// 引用的权威存储兜底解析。
 *
 * 覆盖场景（2026-11-20 生产案例回归）：
 *   1. fc://document/ 在持久化服务中存在 → 解析成功（跨轮引用不再误杀）
 *   2. fc://document/ 文档过期/不存在 → null（闸门拒发）
 *   3. fc://chart/ 缓存命中 → 解析成功
 *   4. fc://mindmap/ 缓存命中 → 解析成功
 *   5. fc://image/（无产生方）→ null
 *   6. 未知协议 → null
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetCachedDocument = jest.fn();
const mockParseChartImageUrl = jest.fn();
const mockParseMindmapImageUrl = jest.fn();

jest.mock('../tools/generate-document', () => ({
  getCachedDocument: (...args: unknown[]) => mockGetCachedDocument(...args),
}));

jest.mock('../tools/multimodal-output', () => ({
  parseChartImageUrl: (...args: unknown[]) => mockParseChartImageUrl(...args),
  parseMindmapImageUrl: (...args: unknown[]) => mockParseMindmapImageUrl(...args),
}));

import { resolveFcAssetFromStores } from './asset-resolver';

describe('resolveFcAssetFromStores —— fc:// 引用权威存储兜底', () => {
  beforeEach(() => {
    mockGetCachedDocument.mockReset();
    mockParseChartImageUrl.mockReset();
    mockParseMindmapImageUrl.mockReset();
  });

  it('fc://document/ 文档存在 → 解析成功并透传原引用', async () => {
    mockGetCachedDocument.mockResolvedValue({
      buffer: Buffer.from('pdf'),
      filename: '日报.pdf',
      mimeType: 'application/pdf',
    });
    const result = await resolveFcAssetFromStores(
      'fc://document/HGQ26MVfKxQ7I82Q',
    );
    expect(result).toEqual({ url: 'fc://document/HGQ26MVfKxQ7I82Q' });
    expect(mockGetCachedDocument).toHaveBeenCalledWith(
      'fc://document/HGQ26MVfKxQ7I82Q',
    );
  });

  it('fc://document/ 文档已过期/不存在 → null（触发拒发）', async () => {
    mockGetCachedDocument.mockResolvedValue(null);
    const result = await resolveFcAssetFromStores('fc://document/ghost');
    expect(result).toBeNull();
  });

  it('fc://chart/ 缓存命中 → 解析成功（跨轮图表引用）', async () => {
    mockParseChartImageUrl.mockResolvedValue({ series: [] });
    const result = await resolveFcAssetFromStores('fc://chart/hj2w2dk2');
    expect(result).toEqual({ url: 'fc://chart/hj2w2dk2' });
    expect(mockParseChartImageUrl).toHaveBeenCalledWith('fc://chart/hj2w2dk2');
  });

  it('fc://mindmap/ 缓存命中 → 解析成功（跨轮导图引用）', async () => {
    mockParseMindmapImageUrl.mockResolvedValue('mindmap\n  root((x))');
    const result = await resolveFcAssetFromStores('fc://mindmap/kmdz5fms');
    expect(result).toEqual({ url: 'fc://mindmap/kmdz5fms' });
  });

  it('fc://image/ 无产生方 → null（不查任何存储）', async () => {
    const result = await resolveFcAssetFromStores('fc://image/abc');
    expect(result).toBeNull();
    expect(mockGetCachedDocument).not.toHaveBeenCalled();
    expect(mockParseChartImageUrl).not.toHaveBeenCalled();
    expect(mockParseMindmapImageUrl).not.toHaveBeenCalled();
  });

  it('未知协议 → null', async () => {
    const result = await resolveFcAssetFromStores('fc://unknown/xyz');
    expect(result).toBeNull();
  });
});
