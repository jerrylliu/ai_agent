/**
 * fundamentals/eval/judge.spec.ts
 *
 * 验证 LLM Judge 模块（Jest，与后端测试框架一致）：
 *   1. judgeOne：LLM 正常输出 → 三维判分透传
 *   2. judgeOne：LLM 输出带 markdown 围栏 → parseLlmJson 兼容抽出
 *   3. judgeOne：LLM 输出非法 JSON / schema 不齐 → 返回 null（不静默当对/错）
 *   4. judgeOne：LLM 调用抛异常 → 返回 null
 *   5. info_not_found 题型：user 消息尾部拼接特殊口径说明
 *   6. aggregateVerdicts：三维比率与 judgeErrorCount 计算
 */

jest.mock('../logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { judgeOne, aggregateVerdicts, type JudgeInput } from './judge.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

// ==================== 测试工具 ====================

/** 构造 mock LLM：invoke 返回给定文本 */
function makeMockLLM(responseText: string | Error): BaseChatModel {
  return {
    invoke: jest.fn().mockImplementation(() => {
      if (responseText instanceof Error) return Promise.reject(responseText);
      return Promise.resolve({ content: responseText });
    }),
  } as unknown as BaseChatModel;
}

function makeInput(overrides?: Partial<JudgeInput>): JudgeInput {
  return {
    question: 'What approval rating did ACME product get?',
    answer: 'ACME product got an 80% approval rating.',
    goldAnswer: '80%',
    answerFacts: ['The product received an 80% approval rating'],
    contexts: [
      '--- 文档正文 ---\nThe product received an 80% approval rating.',
    ],
    questionType: 'basic',
    ...overrides,
  };
}

const VALID_JSON =
  '{"answer_correct": true, "faithful": true, "relevant": true, "unfaithful_claims": [], "reason": "关键事实一致"}';

beforeEach(() => {
  jest.clearAllMocks();
});

// ==================== judgeOne ====================

describe('judgeOne', () => {
  it('LLM 正常输出 → 三维判分透传', async () => {
    const verdict = await judgeOne(makeMockLLM(VALID_JSON), makeInput());
    expect(verdict).not.toBeNull();
    expect(verdict?.answer_correct).toBe(true);
    expect(verdict?.faithful).toBe(true);
    expect(verdict?.relevant).toBe(true);
    expect(verdict?.unfaithful_claims).toEqual([]);
  });

  it('LLM 输出带 markdown 围栏 → 兼容抽出', async () => {
    const fenced = '好的，判分如下：\n```json\n' + VALID_JSON + '\n```';
    const verdict = await judgeOne(makeMockLLM(fenced), makeInput());
    expect(verdict).not.toBeNull();
    expect(verdict?.answer_correct).toBe(true);
  });

  it('LLM 输出非法 JSON → 返回 null 不抛异常', async () => {
    const verdict = await judgeOne(
      makeMockLLM('我判断这道题是对的'),
      makeInput(),
    );
    expect(verdict).toBeNull();
  });

  it('LLM 输出 schema 不齐（缺 faithful 字段）→ 返回 null', async () => {
    const bad =
      '{"answer_correct": true, "relevant": true, "reason": "缺字段"}';
    const verdict = await judgeOne(makeMockLLM(bad), makeInput());
    expect(verdict).toBeNull();
  });

  it('LLM 调用抛异常 → 返回 null', async () => {
    const verdict = await judgeOne(
      makeMockLLM(new Error('rate limited')),
      makeInput(),
    );
    expect(verdict).toBeNull();
  });

  it('info_not_found 题型 → user 消息包含特殊口径说明', async () => {
    const mock = makeMockLLM(VALID_JSON);
    await judgeOne(
      mock,
      makeInput({
        questionType: 'info_not_found',
        goldAnswer: '',
        answerFacts: [],
        contexts: [],
        answer: '文档中没有相关信息。',
      }),
    );
    expect(mock.invoke).toHaveBeenCalledTimes(1);
    const messages = (mock.invoke as jest.Mock).mock.calls[0][0] as Array<{
      content: string;
    }>;
    const userMsg = messages.map((m) => m.content).join('\n');
    expect(userMsg).toContain('信息不存在');
    expect(userMsg).toContain('（无检索上下文）');
  });

  it('多 contexts → 全部拼入 user 消息', async () => {
    const mock = makeMockLLM(VALID_JSON);
    await judgeOne(mock, makeInput({ contexts: ['ctx-a', 'ctx-b', 'ctx-c'] }));
    const messages = (mock.invoke as jest.Mock).mock.calls[0][0] as Array<{
      content: string;
    }>;
    const userMsg = messages.map((m) => m.content).join('\n');
    expect(userMsg).toContain('ctx-a');
    expect(userMsg).toContain('ctx-b');
    expect(userMsg).toContain('ctx-c');
  });
});

// ==================== aggregateVerdicts ====================

describe('aggregateVerdicts', () => {
  it('三维比率与 judgeErrorCount 正确', () => {
    const verdicts = [
      {
        answer_correct: true,
        faithful: true,
        relevant: true,
        unfaithful_claims: [],
        reason: '',
      },
      {
        answer_correct: true,
        faithful: false,
        relevant: true,
        unfaithful_claims: ['编造句'],
        reason: '',
      },
      {
        answer_correct: false,
        faithful: true,
        relevant: false,
        unfaithful_claims: [],
        reason: '',
      },
      {
        answer_correct: true,
        faithful: true,
        relevant: true,
        unfaithful_claims: [],
        reason: '',
      },
    ];
    const agg = aggregateVerdicts(verdicts, 5); // 4 成功 + 1 失败
    expect(agg.judgedCount).toBe(4);
    expect(agg.judgeErrorCount).toBe(1);
    expect(agg.correctnessRate).toBe(0.75);
    expect(agg.faithfulnessRate).toBe(0.75);
    expect(agg.relevanceRate).toBe(0.75);
  });

  it('空列表 → 全 0 且不产生 NaN', () => {
    const agg = aggregateVerdicts([], 0);
    expect(agg.judgedCount).toBe(0);
    expect(agg.judgeErrorCount).toBe(0);
    expect(agg.correctnessRate).toBe(0);
    expect(agg.faithfulnessRate).toBe(0);
    expect(agg.relevanceRate).toBe(0);
  });
});
