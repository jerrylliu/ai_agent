/**
 * fundamentals/vector-store/bm25-engine.spec.ts
 *
 * BM25 引擎抽象层（工厂 + 单例）单元测试
 * 覆盖：默认引擎选型 / 单例语义 / tantivy 适配器选型 / 非法值 fail-fast
 *
 * 注意：适配器自身的增删落盘行为由 bm25-index.spec.ts 经门面覆盖（S1.7a 门面 1:1 委派）
 */

/* =====================================================================
 * Mock 基础模块
 * ==================================================================*/
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// config 需要可控：工厂按 config.bm25Engine 选型
const mockConfig: { bm25Engine: string } = { bm25Engine: 'minisearch' };
jest.mock('../config', () => ({
  config: mockConfig,
}));

// 引擎适配器只依赖 store-state 的读写函数与 fs，这里隔离掉真实磁盘/全局状态
jest.mock('./store-state', () => ({
  PERSIST_DIR: '/tmp/bm25-engine-test',
  getBM25Index: () => null,
  setBM25Index: jest.fn(),
  getBM25DocumentStore: () => new Map(),
  setBM25DocumentStore: jest.fn(),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

import { getBM25Engine, resetBM25Engine } from './bm25-engine';
import { MiniSearchBM25Engine } from './minisearch-engine';
import { TantivyBM25Engine } from './tantivy-engine';

describe('BM25 引擎工厂', () => {
  beforeEach(() => {
    mockConfig.bm25Engine = 'minisearch';
    resetBM25Engine();
  });

  afterAll(() => {
    resetBM25Engine();
  });

  it('默认应返回 MiniSearch 适配器', () => {
    const engine = getBM25Engine();
    expect(engine).toBeInstanceOf(MiniSearchBM25Engine);
    expect(engine.type).toBe('minisearch');
  });

  it('应实现窄接口的全部方法', () => {
    const engine = getBM25Engine();
    expect(typeof engine.init).toBe('function');
    expect(typeof engine.add).toBe('function');
    expect(typeof engine.commit).toBe('function');
    expect(typeof engine.search).toBe('function');
    expect(typeof engine.delete).toBe('function');
    expect(typeof engine.clear).toBe('function');
  });

  it('同一进程内应返回同一实例（进程级全局单例，红线 #10）', () => {
    const first = getBM25Engine();
    const second = getBM25Engine();
    expect(first).toBe(second);
  });

  it('BM25_ENGINE=tantivy 时应返回 Tantivy 适配器', () => {
    mockConfig.bm25Engine = 'tantivy';
    resetBM25Engine();
    const engine = getBM25Engine();
    expect(engine).toBeInstanceOf(TantivyBM25Engine);
    expect(engine.type).toBe('tantivy');
  });

  it('未知引擎类型应 fail-fast', () => {
    mockConfig.bm25Engine = 'elasticsearch';
    resetBM25Engine();
    expect(() => getBM25Engine()).toThrow(/未知的 BM25 引擎类型/);
  });

  it('resetBM25Engine 后应重新创建实例（仅供测试）', () => {
    const first = getBM25Engine();
    resetBM25Engine();
    const second = getBM25Engine();
    expect(second).not.toBe(first);
    expect(second).toBeInstanceOf(MiniSearchBM25Engine);
  });
});
