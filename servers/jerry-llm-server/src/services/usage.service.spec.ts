/**
 * services/usage.service.spec.ts
 *
 * 验证 saveLlmUsage 的检索上下文存档行为：
 *   1. retrievedDocumentIds / retrievedContexts 有值 → JSON 数组字符串落列
 *   2. 未传 / 空数组 → 落 null（区别于"存了空串"）
 *   3. 基础字段照常透传（回归保护）
 */

jest.mock('../fundamentals/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { UsageService } from './usage.service';
import { LlmUsage } from '../entities/llm-usage.entity';
import type { Repository } from 'typeorm';
import type { UsageData } from '../fundamentals/prompt';

type UsageRepoMock = { create: jest.Mock; save: jest.Mock };

function makeRepo(): UsageRepoMock {
  return {
    create: jest.fn((data: Partial<LlmUsage>) => data),
    save: jest.fn(async (data: Partial<LlmUsage>) => data),
  };
}

function makeUsageData(overrides?: Partial<UsageData>): UsageData {
  return {
    userId: 'default',
    sessionId: 'session-1',
    modelId: 'deepseek:deepseek-v4-flash',
    inputTokens: 100,
    outputTokens: 200,
    historyCount: 3,
    usedKnowledgeBase: true,
    imageCount: 0,
    responseTimeMs: 1200,
    userMessage: '问题',
    assistantMessage: '回答',
    ...overrides,
  } as UsageData;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('saveLlmUsage 检索上下文存档', () => {
  it('有检索结果 → 数组序列化为 JSON 字符串落列', async () => {
    const repo = makeRepo();
    const service = new UsageService(repo as unknown as Repository<LlmUsage>);

    await service.saveLlmUsage(
      makeUsageData({
        retrievedDocumentIds: ['doc-a', 'doc-b'],
        retrievedContexts: ['片段一', '片段二'],
      }),
    );

    const record = repo.create.mock.calls[0][0] as {
      retrievedDocumentIds: string | null;
      retrievedContexts: string | null;
    };
    expect(JSON.parse(record.retrievedDocumentIds ?? '')).toEqual([
      'doc-a',
      'doc-b',
    ]);
    expect(JSON.parse(record.retrievedContexts ?? '')).toEqual([
      '片段一',
      '片段二',
    ]);
  });

  it('未传检索结果 → 两列落 null', async () => {
    const repo = makeRepo();
    const service = new UsageService(repo as unknown as Repository<LlmUsage>);

    await service.saveLlmUsage(makeUsageData());

    const record = repo.create.mock.calls[0][0] as {
      retrievedDocumentIds: string | null;
      retrievedContexts: string | null;
    };
    expect(record.retrievedDocumentIds).toBeNull();
    expect(record.retrievedContexts).toBeNull();
  });

  it('空数组 → 两列落 null（不存空串）', async () => {
    const repo = makeRepo();
    const service = new UsageService(repo as unknown as Repository<LlmUsage>);

    await service.saveLlmUsage(
      makeUsageData({ retrievedDocumentIds: [], retrievedContexts: [] }),
    );

    const record = repo.create.mock.calls[0][0] as {
      retrievedDocumentIds: string | null;
      retrievedContexts: string | null;
    };
    expect(record.retrievedDocumentIds).toBeNull();
    expect(record.retrievedContexts).toBeNull();
  });

  it('基础字段照常透传（回归保护）', async () => {
    const repo = makeRepo();
    const service = new UsageService(repo as unknown as Repository<LlmUsage>);

    await service.saveLlmUsage(
      makeUsageData({ userMessage: '一段比较长的问题'.repeat(100) }),
    );

    const record = repo.create.mock.calls[0][0] as {
      userId: string;
      inputTokens: number;
      userMessage: string;
    };
    expect(record.userId).toBe('default');
    expect(record.inputTokens).toBe(100);
    // userMessage 截 500 字的既有口径不变
    expect(record.userMessage.length).toBe(500);
  });
});
