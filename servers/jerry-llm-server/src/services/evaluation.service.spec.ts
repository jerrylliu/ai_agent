/**
 * services/evaluation.service.spec.ts
 *
 * 在线 judge 集成逻辑验证（Jest）：
 *   1. autoEvaluate 保存规则分后，有 contexts → 调 judgeOne 并把判分回写 judge* 列
 *   2. faithful=false + 编造句 → unfaithfulClaims 以 JSON 数组字符串落列
 *   3. 无 contexts → 跳过 judge（纯对话/纯工具回答没有核对依据）
 *   4. onlineJudgeEnabled=false → 跳过 judge
 *   5. judgeOne 返回 null（模型异常/解析失败）→ 不回写，行保留规则分
 *   6. judge 模型创建失败（如 Key 未配置）→ 静默跳过，不抛异常
 *   7. 回归保护：规则分计算行为不变
 */

jest.mock('../fundamentals/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../fundamentals/config.js', () => ({
  config: {
    onlineJudgeEnabled: true,
    onlineJudgeModel: 'zhipu:glm-4.7',
  },
}));

jest.mock('../fundamentals/model-provider.js', () => ({
  buildModelConfig: jest.fn(() => ({
    provider: 'zhipu',
    model: 'glm-4.7',
  })),
  createLLM: jest.fn(() => ({ invoke: jest.fn() })),
}));

jest.mock('../fundamentals/eval/judge.js', () => ({
  judgeOne: jest.fn(),
}));

import { EvaluationService } from './evaluation.service';
import { AutoEvaluation } from '../entities/auto-evaluation.entity';
import { MessageFeedback } from '../entities/message-feedback.entity';
import { SearchFeedback } from '../entities/search-feedback.entity';
import { config } from '../fundamentals/config.js';
import { logger } from '../fundamentals/logger';
import { createLLM } from '../fundamentals/model-provider.js';
import { judgeOne } from '../fundamentals/eval/judge.js';
import type { Repository } from 'typeorm';
import type { JudgeVerdict } from '../fundamentals/eval/judge.js';

// ==================== 测试工具 ====================

type AutoEvalRepoMock = {
  create: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
};

function makeAutoEvalRepo(): AutoEvalRepoMock {
  return {
    create: jest.fn((data: Partial<AutoEvaluation>) => data),
    save: jest.fn(async (data: Partial<AutoEvaluation>) => ({
      id: 42,
      ...data,
    })),
    update: jest.fn(async () => undefined),
  };
}

/** flush fire-and-forget 的 judge 链路（save → judgeOne → update 全部为微任务/即时 resolve） */
const flushAsync = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const FAITHFUL_FALSE_VERDICT: JudgeVerdict = {
  answer_correct: false,
  faithful: false,
  relevant: true,
  unfaithful_claims: ['答案里编造的句子'],
  reason: '存在上下文无法支撑的细节',
};

const BASE_PARAMS = {
  userId: 'default',
  sessionId: 'session-1',
  userMessage: 'ACME 产品的折扣是多少？',
  assistantMessage:
    '根据文档，ACME 产品首年享受 30% 折扣，合作伙伴分成前两个季度为 15%。',
  usedKnowledgeBase: true,
};

function buildService(autoEvalRepo: AutoEvalRepoMock): EvaluationService {
  return new EvaluationService(
    {} as unknown as Repository<MessageFeedback>,
    autoEvalRepo as unknown as Repository<AutoEvaluation>,
    {} as unknown as Repository<SearchFeedback>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  // 恢复 mock config 默认值（个别测试会改开关）
  config.onlineJudgeEnabled = true;
  config.onlineJudgeModel = 'zhipu:glm-4.7';
});

// ==================== 在线 judge 集成 ====================

describe('autoEvaluate 在线 judge 集成', () => {
  it('有 contexts 且判分成功 → judge* 列回写判定结果', async () => {
    const repo = makeAutoEvalRepo();
    const service = buildService(repo);
    (judgeOne as jest.Mock).mockResolvedValue(FAITHFUL_FALSE_VERDICT);

    await service.autoEvaluate({
      ...BASE_PARAMS,
      retrievedContexts: ['文档片段：ACME 首年 30% 折扣'],
    });
    await flushAsync();

    expect(judgeOne).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith(42, {
      judgeFaithful: false,
      judgeRelevant: true,
      unfaithfulClaims: JSON.stringify(['答案里编造的句子']),
      judgeReason: '存在上下文无法支撑的细节',
      judgeModel: 'zhipu:glm-4.7',
    });
  });

  it('judge 输入：question/answer/contexts 按参数传入，questionType=online', async () => {
    const repo = makeAutoEvalRepo();
    const service = buildService(repo);
    (judgeOne as jest.Mock).mockResolvedValue(FAITHFUL_FALSE_VERDICT);

    await service.autoEvaluate({
      ...BASE_PARAMS,
      retrievedContexts: ['ctx-1'],
    });
    await flushAsync();

    // judgeOne(llm, input, options)：input 在第二个参数
    const input = (judgeOne as jest.Mock).mock.calls[0][1] as {
      question: string;
      answer: string;
      goldAnswer: string;
      questionType: string;
      contexts: string[];
    };
    expect(input.question).toBe(BASE_PARAMS.userMessage);
    expect(input.answer).toBe(BASE_PARAMS.assistantMessage);
    expect(input.goldAnswer).toBe('');
    expect(input.questionType).toBe('online');
    expect(input.contexts).toEqual(['ctx-1']);
  });

  it('无 contexts → 跳过 judge（不调 judgeOne、不 update）', async () => {
    const repo = makeAutoEvalRepo();
    const service = buildService(repo);

    await service.autoEvaluate({ ...BASE_PARAMS });
    await flushAsync();

    expect(judgeOne).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    // 规则分照常保存
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('contexts 全为空白字符串 → 视为无上下文，跳过 judge', async () => {
    const repo = makeAutoEvalRepo();
    const service = buildService(repo);

    await service.autoEvaluate({
      ...BASE_PARAMS,
      retrievedContexts: ['   ', ''],
    });
    await flushAsync();

    expect(judgeOne).not.toHaveBeenCalled();
  });

  it('onlineJudgeEnabled=false → 跳过 judge', async () => {
    config.onlineJudgeEnabled = false;
    const repo = makeAutoEvalRepo();
    const service = buildService(repo);

    await service.autoEvaluate({
      ...BASE_PARAMS,
      retrievedContexts: ['ctx-1'],
    });
    await flushAsync();

    expect(judgeOne).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('judgeOne 返回 null（模型异常/解析失败）→ 不回写 judge 列，行保留规则分', async () => {
    const repo = makeAutoEvalRepo();
    const service = buildService(repo);
    (judgeOne as jest.Mock).mockResolvedValue(null);

    const saved = await service.autoEvaluate({
      ...BASE_PARAMS,
      retrievedContexts: ['ctx-1'],
    });
    await flushAsync();

    expect(saved.score).toBeGreaterThan(0);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('judge 模型创建失败（Key 未配置）→ 静默跳过判分，规则分正常返回', async () => {
    const repo = makeAutoEvalRepo();
    const service = buildService(repo);
    // Once：只让下一次 createLLM 抛错，避免 implementation 泄漏到后续测试
    (createLLM as jest.Mock).mockImplementationOnce(() => {
      throw new Error('智谱模型需要 API Key');
    });
    (judgeOne as jest.Mock).mockResolvedValue(FAITHFUL_FALSE_VERDICT);

    const saved = await service.autoEvaluate({
      ...BASE_PARAMS,
      retrievedContexts: ['ctx-1'],
    });
    await flushAsync();

    expect(saved.id).toBe(42);
    expect(judgeOne).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('contexts 超长/超量 → 截断到保护上限后送给 judge', async () => {
    const repo = makeAutoEvalRepo();
    const service = buildService(repo);
    (judgeOne as jest.Mock).mockResolvedValue(FAITHFUL_FALSE_VERDICT);

    const bigContexts = Array.from({ length: 20 }, (_, i) =>
      `c${i}`.padEnd(3000, 'x'),
    );
    await service.autoEvaluate({
      ...BASE_PARAMS,
      retrievedContexts: bigContexts,
    });
    await flushAsync();

    // judgeOne(llm, input, options)：input 在第二个参数
    const input = (judgeOne as jest.Mock).mock.calls[0][1] as {
      contexts: string[];
    };
    expect(input.contexts.length).toBe(12);
    expect(input.contexts[0].length).toBe(2400);
  });

  it('答案/问题超长 → 头尾保留截断（保两端掐中间+省略标记），截断时打 warn', async () => {
    const repo = makeAutoEvalRepo();
    const service = buildService(repo);
    (judgeOne as jest.Mock).mockResolvedValue(FAITHFUL_FALSE_VERDICT);

    // 头部定主题、尾部放核心结论（用户习惯先贴资料后提问，尾部信息密度高）；
    // 尾块足够长（>tail 保留量）以验证中段真正被掐掉
    const question = `${'Q'.repeat(1600)}${'M'.repeat(1300)}核心诉求TAIL`;
    const answer = `${'A'.repeat(5000)}${'M'.repeat(500)}结尾${'T'.repeat(1300)}`;
    await service.autoEvaluate({
      ...BASE_PARAMS,
      userMessage: question,
      assistantMessage: answer,
      retrievedContexts: ['ctx-1'],
    });
    await flushAsync();

    // judgeOne(llm, input, options)：input 在第二个参数
    const input = (judgeOne as jest.Mock).mock.calls[0][1] as {
      question: string;
      answer: string;
    };
    // 总长收敛到上限（含省略标记）
    expect(input.question.length).toBe(2000);
    expect(input.answer.length).toBe(6000);
    // 显式告知 judge 有省略，防头尾拼接误读
    expect(input.question).toContain('【中间内容因超长已省略】');
    expect(input.answer).toContain('【中间内容因超长已省略】');
    // 头部与尾部均保留（尾部核心诉求不丢；断言用安全余量，不与 80/20 比例硬耦合）
    expect(input.question.startsWith(question.slice(0, 1000))).toBe(true);
    expect(input.question.endsWith('核心诉求TAIL')).toBe(true);
    expect(input.answer.startsWith(answer.slice(0, 4000))).toBe(true);
    expect(input.answer.endsWith(answer.slice(-1000))).toBe(true);
    // 中段确被掐掉
    expect(input.question.includes('M'.repeat(500))).toBe(false);
    expect(input.answer.includes('M'.repeat(500))).toBe(false);
    // 截断率可观测：warn 恰好一次
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('头尾保留截断'),
      expect.objectContaining({
        module: 'EvaluationService',
        questionLen: question.length,
        answerLen: answer.length,
      }),
    );
  });

  it('未超长的消息 → 原样送给 judge，不打截断 warn', async () => {
    const repo = makeAutoEvalRepo();
    const service = buildService(repo);
    (judgeOne as jest.Mock).mockResolvedValue(FAITHFUL_FALSE_VERDICT);

    await service.autoEvaluate({
      ...BASE_PARAMS,
      retrievedContexts: ['ctx-1'],
    });
    await flushAsync();

    const input = (judgeOne as jest.Mock).mock.calls[0][1] as {
      question: string;
      answer: string;
    };
    expect(input.question).toBe(BASE_PARAMS.userMessage);
    expect(input.answer).toBe(BASE_PARAMS.assistantMessage);
    const truncWarn = (logger.warn as jest.Mock).mock.calls.filter((call) =>
      String(call[0]).includes('头尾保留截断'),
    );
    expect(truncWarn).toHaveLength(0);
  });
});

// ==================== 规则分回归保护 ====================

describe('autoEvaluate 规则分（回归保护）', () => {
  it('长回答 + 用了知识库 + 有【文档 N】标注 → 规则加分正常累计', async () => {
    const repo = makeAutoEvalRepo();
    const service = buildService(repo);

    const longAnswer = `${'很长的回答'.repeat(20)}【文档 1】`;
    await service.autoEvaluate({
      ...BASE_PARAMS,
      assistantMessage: longAnswer,
    });
    await flushAsync();

    const saved = (await service.autoEvaluate({
      ...BASE_PARAMS,
      assistantMessage: longAnswer,
    })) as Partial<AutoEvaluation>;
    // 0.5 + 内容充实 0.1 + 知识库 0.15 + 标注来源 0.1 = 0.85
    expect(saved.score).toBeCloseTo(0.85, 5);
    expect(repo.save).toHaveBeenCalled();
  });
});
