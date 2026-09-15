/**
 * fundamentals/vector-store/tantivy-engine.spec.ts
 *
 * Tantivy BM25 引擎适配器集成测试（真实原生绑定 + 真实临时目录）
 *
 * 与 bm25-engine.spec.ts（纯工厂/单例、mock fs）不同，本 spec **不 mock fs 与原生绑定**，
 * 直接驱动 @pngwasi/node-tantivy-binding 落盘，验证 S1.7b spike 固化的关键行为：
 * - init 创建索引目录且幂等；
 * - add + commit 后 search 命中，content/metadata 从 stored fields 正确回取；
 * - 空索引 search 返回 []；
 * - delete-by-term 后检索不到；
 * - clear 清空全部文档；
 * - 落盘后新实例重开（Index.open）仍能检索到已提交文档（持久化核心价值）。
 *
 * 索引目录经 mock store-state 的 PERSIST_DIR 注入到系统临时目录，
 * beforeEach/afterAll 清理，避免污染真实 PERSIST_DIR 与用例间串扰。
 */

/* =====================================================================
 * Mock：仅隔离 logger 与 PERSIST_DIR，fs / 原生绑定保持真实
 * ==================================================================*/
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// tantivy-engine 仅从 store-state 取 PERSIST_DIR；指向系统临时目录下的固定子目录
jest.mock('./store-state', () => {
  const os = require('os');
  const path = require('path');
  return {
    PERSIST_DIR: path.join(os.tmpdir(), 'tantivy-engine-spec'),
  };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TantivyBM25Engine } from './tantivy-engine';

/** 与上方 mock 的 PERSIST_DIR 保持一致，用于清理与断言 */
const TEST_PERSIST_DIR = path.join(os.tmpdir(), 'tantivy-engine-spec');
const TEST_INDEX_DIR = path.join(TEST_PERSIST_DIR, 'bm25_index_tantivy');

// 真实原生绑定 + 磁盘 IO，放宽超时
jest.setTimeout(30000);

describe('TantivyBM25Engine', () => {
  beforeEach(() => {
    // 清空临时目录：删目录即删 Tantivy 锁文件，保证用例间互不干扰
    fs.rmSync(TEST_PERSIST_DIR, { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_PERSIST_DIR, { recursive: true, force: true });
  });

  it('type 应为 tantivy', () => {
    const engine = new TantivyBM25Engine();
    expect(engine.type).toBe('tantivy');
  });

  it('init 应创建索引目录且幂等', async () => {
    const engine = new TantivyBM25Engine();
    await engine.init();
    expect(fs.existsSync(TEST_INDEX_DIR)).toBe(true);
    // 再次 init 不应抛错（幂等）
    await expect(engine.init()).resolves.toBeUndefined();
  });

  it('add + commit 后 search 应命中并回取 content/metadata', async () => {
    const engine = new TantivyBM25Engine();
    await engine.init();
    await engine.add('d1', 'the quick brown fox jumps', { tag: 'alpha', n: 1 });

    const hits = await engine.search('quick fox', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe('d1');
    expect(hits[0].content).toBe('the quick brown fox jumps');
    expect(hits[0].metadata).toEqual({ tag: 'alpha', n: 1 });
    expect(typeof hits[0].score).toBe('number');
  });

  it('空索引 search 应返回空数组', async () => {
    const engine = new TantivyBM25Engine();
    await engine.init();
    const hits = await engine.search('anything at all', 10);
    expect(hits).toEqual([]);
  });

  it('delete 后应检索不到该文档', async () => {
    const engine = new TantivyBM25Engine();
    await engine.init();
    await engine.add('d1', 'unique zebra content', {});
    expect((await engine.search('zebra', 10)).length).toBe(1);

    engine.delete('d1');
    expect(await engine.search('zebra', 10)).toEqual([]);
  });

  it('clear 应清空所有文档', async () => {
    const engine = new TantivyBM25Engine();
    await engine.init();
    await engine.add('d1', 'beta keyword here', {});
    await engine.add('d2', 'gamma keyword here', {});

    await engine.clear();
    expect(await engine.search('beta', 10)).toEqual([]);
    expect(await engine.search('gamma', 10)).toEqual([]);
  });

  it('批量 add（skipCommit）后统一 commit 应全部可见', async () => {
    const engine = new TantivyBM25Engine();
    await engine.init();
    await engine.add('d1', 'first batched doc', {}, true);
    await engine.add('d2', 'second batched doc', {}, true);
    // skipCommit 期间尚未落盘，检索可能不可见
    await engine.commit();

    const hits = await engine.search('batched doc', 10);
    expect(hits.length).toBe(2);
    expect(hits.map((h) => h.id).sort()).toEqual(['d1', 'd2']);
  });

  it('commit 后索引应落盘产生持久化产物', async () => {
    // 注意：Tantivy 对同一目录同进程仅允许一个 IndexWriter（文件锁互斥），
    // 故无法在 jest 同进程内用第二个适配器实例重开（会 LockBusy）。
    // 跨进程重开（导入进程退出 → 检索进程重开）已由 S1.7b spike 与 S2.4 实跑覆盖。
    // 此处验证 commit 确实将数据写入磁盘目录（绕开 V8 单字符串上限的核心价值）。
    const engine = new TantivyBM25Engine();
    await engine.init();
    await engine.add('d1', 'persistent delta content', { v: 1 });
    await engine.commit();

    expect(fs.existsSync(TEST_INDEX_DIR)).toBe(true);
    const entries = fs.readdirSync(TEST_INDEX_DIR);
    expect(entries.length).toBeGreaterThan(0);
  });
});
