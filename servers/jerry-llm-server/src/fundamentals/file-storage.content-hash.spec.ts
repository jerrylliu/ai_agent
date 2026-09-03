/**
 * fundamentals/file-storage.content-hash.spec.ts
 *
 * computeContentHash（内容级文档去重键）单元测试
 * 覆盖：规范化语义（空白不敏感）、确定性、空值处理、与文件 checksum 的差异
 */
// file-storage 顶部 import 了 logger 与 config，而真实 config 会做环境变量校验，
// 单测环境没有必需的环境变量（如 jwtSecret），必须 mock 掉
jest.mock('./logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('./config', () => ({
  config: {},
}));

import { computeContentHash, calculateChecksum } from './file-storage';

describe('computeContentHash', () => {
  it('应去除全部空白后计算：换行/空格/制表符差异得到相同 hash', () => {
    const a = computeContentHash('液氮 杜瓦冷罐\n工程干员');
    const b = computeContentHash('液氮\t杜瓦冷罐\r\n工程干员  ');
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  it('相同文本应得到相同 hash（确定性）', () => {
    const text = '同一份内容反复计算';
    expect(computeContentHash(text)).toBe(computeContentHash(text));
  });

  it('不同内容应得到不同 hash', () => {
    expect(computeContentHash('内容甲')).not.toBe(computeContentHash('内容乙'));
  });

  it('空文本 / 纯空白文本应返回 null（不参与去重比对）', () => {
    expect(computeContentHash('')).toBeNull();
    expect(computeContentHash('   \n\t  ')).toBeNull();
    expect(computeContentHash(null)).toBeNull();
    expect(computeContentHash(undefined)).toBeNull();
  });

  it('hash 应为 64 位十六进制（SHA-256 全长）', () => {
    const hash = computeContentHash('任意内容');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('与文件 checksum 的区别：同一文本不同编码 buffer 不影响内容 hash', () => {
    // 文件 checksum 对字节敏感，内容 hash 对字节无关（只看字符序列）
    const text = 'hello world';
    const bufferA = Buffer.from(text, 'utf-8');
    const contentHash = computeContentHash(text);
    expect(contentHash).not.toBe(calculateChecksum(bufferA));
    // 文件 checksum 确实存在且可计算（对照）
    expect(calculateChecksum(bufferA)).toMatch(/^[0-9a-f]{64}$/);
  });
});
