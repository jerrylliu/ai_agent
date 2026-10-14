/**
 * services/semantic-fill.service.spec.ts
 *
 * 语义填充编排服务测试（Jest，LLM 层整体 mock，纯函数层用真实实现）：
 *   1. preview 路径决策：无空缺抛错 / 去重 ≤100 走映射路径 / 去重 >100 出分批报价（不调 LLM）
 *   2. 映射路径：全量映射成功刷全表 / LLM 缺值整体拒绝 / suggestRule 透传 / targetSheet 定位
 *   3. 规则门禁（功能 5）：新增违规整体拒绝 / 文档既有违规不连坐（只拒绝新增） /
 *      规则约束注入填充提示词 / 规则加载失败放行 / 分批终态门禁拒绝置 failed
 *   4. 分批任务：start→done 全链路 / 多批进度 / 批失败保留已完成部分 / 协作式取消 / 并发上限
 *   5. 任务查询与取消：不存在返回 null / 终态无需取消
 */

jest.mock('../fundamentals/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../fundamentals/table-ops/semantic-fill-llm.js', () => ({
  inferFillMapping: jest.fn(),
  inferBatchFill: jest.fn(),
}));

import { SemanticFillService } from './semantic-fill.service';
import type { SemanticFillTaskStatus } from './semantic-fill.service';
import { TableRuleService } from './table-rule.service';
import { inferFillMapping, inferBatchFill } from '../fundamentals/table-ops/semantic-fill-llm.js';
import { TableOpsError } from '../fundamentals/table-ops/executor.js';
import type { TableRuleRuntime } from '../fundamentals/table-ops/rules.js';
import type {
  BatchFillOutput,
  FillMappingOutput,
  FillRuleSuggestion,
} from '../fundamentals/table-ops/semantic-fill.js';

const mockInferFillMapping = inferFillMapping as jest.Mock;
const mockInferBatchFill = inferBatchFill as jest.Mock;

// ==================== 测试工具 ====================

/** 两列小表：负责人列 3 个空缺，依据列"区域"去重 2 种（映射路径典型场景） */
const MAPPING_SHEET = ['Sheet: 销售表', '地区,区域,负责人', '北京,华北,', '上海,华东,', '广州,华南,老王', '杭州,华东,'].join(
  '\n',
);

/** 守规矩 LLM 对 MAPPING_SHEET 的完整映射输出 */
const FULL_MAPPING: FillMappingOutput = {
  mapping: [
    { from: '华北', to: '老张' },
    { from: '华东', to: '老李' },
  ],
};

/** MAPPING_SHEET 填充后的期望文本（与 executor 序列化格式一致） */
const MAPPING_FILLED_TEXT = [
  'Sheet: 销售表',
  '地区,区域,负责人',
  '北京,华北,老张',
  '上海,华东,老李',
  '广州,华南,老王',
  '杭州,华东,老李',
].join('\n');

/** 生成 n 个空缺行（每行分组值唯一）的表格文本：目标列置中，避免行尾空单元格的解析歧义 */
function makeWideSheet(rowCount: number): string {
  const lines = ['Sheet: t', '负责人,地区'];
  for (let i = 1; i <= rowCount; i++) {
    lines.push(`,r${i}`);
  }
  return lines.join('\n');
}

/** 单行空缺的小表（分批任务测试用） */
const SMALL_SHEET = ['Sheet: t', '负责人,地区', ',北京'].join('\n');

/** TableRuleService 桩：语义填充只用到 getEnabledRules */
function makeRuleService(rules: TableRuleRuntime[] | Error): TableRuleService {
  return {
    getEnabledRules: jest.fn(async () => {
      if (rules instanceof Error) throw rules;
      return rules;
    }),
  } as unknown as TableRuleService;
}

/** 模拟守规矩的 LLM：从 buildBatchRowsText 的"第 N 行：…"文本提取行号并逐行给出填充 */
function fillsForRowsText(rowsText: string): BatchFillOutput {
  const rows = [...rowsText.matchAll(/第 (\d+) 行/g)].map((m) => Number(m[1]));
  return { fills: rows.map((row) => ({ row, value: `填${row}` })) };
}

/** 等待后台任务到终态（LLM mock 为微任务级，轮询即可；超时直接失败） */
async function waitForTerminal(
  service: SemanticFillService,
  taskId: string,
  maxMs = 5000,
): Promise<SemanticFillTaskStatus> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const status = service.getTaskStatus(taskId);
    if (status && status.status !== 'running') return status;
    if (Date.now() > deadline) throw new Error(`任务 ${taskId} 未在 ${maxMs}ms 内到终态`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ==================== 测试 ====================

describe('SemanticFillService', () => {
  let service: SemanticFillService;

  beforeEach(() => {
    // reset 而非 clear：清掉上个用例残留的 mockImplementation（如多批任务的持久实现）
    jest.resetAllMocks();
    service = new SemanticFillService(makeRuleService([]));
  });

  // ==================== preview：路径决策 ====================

  describe('preview 路径决策', () => {
    it('目标列没有空缺时抛业务错误', async () => {
      const text = ['Sheet: t', '地区,负责人', '北京,老王', '上海,老李'].join('\n');
      const err = await service
        .preview({ instruction: '', sheetText: text, targetColumn: '负责人', hintColumns: ['地区'] })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TableOpsError);
      expect((err as Error).message).toContain('没有空缺单元格');
    });

    it('去重 ≤100 → 映射路径：一次 LLM 调用推断去重值，代码刷全表', async () => {
      mockInferFillMapping.mockResolvedValueOnce(FULL_MAPPING);
      const result = await service.preview({
        instruction: '按区域补负责人',
        sheetText: MAPPING_SHEET,
        targetColumn: '负责人',
        hintColumns: ['区域'],
      });
      expect(result).toMatchObject({
        path: 'mapping',
        ok: true,
        targetColumn: '负责人',
        hintColumns: ['区域'],
        emptyCount: 3,
        distinctCount: 2,
        filledText: MAPPING_FILLED_TEXT,
        appliedRows: 3,
        mapping: FULL_MAPPING.mapping,
      });
      expect(mockInferFillMapping).toHaveBeenCalledTimes(1);
      const [stats, instruction] = mockInferFillMapping.mock.calls[0] as [unknown, unknown];
      expect(stats).toMatchObject({ targetColumn: '负责人', hintColumns: ['区域'], distinctCount: 2 });
      expect(instruction).toBe('按区域补负责人');
    });

    it('LLM 漏掉去重值 → 逐值校验整体拒绝', async () => {
      mockInferFillMapping.mockResolvedValueOnce({ mapping: [{ from: '华北', to: '老张' }] });
      const err = await service
        .preview({ instruction: '', sheetText: MAPPING_SHEET, targetColumn: '负责人', hintColumns: ['区域'] })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TableOpsError);
      expect((err as Error).message).toContain('已整体拒绝');
      expect((err as Error).message).toContain('华东');
    });

    it('suggestRule 规则提议随映射结果透传', async () => {
      const suggestRule: FillRuleSuggestion = {
        name: '区域白名单',
        column: '区域',
        values: ['华北', '华东'],
      };
      mockInferFillMapping.mockResolvedValueOnce({ ...FULL_MAPPING, suggestRule });
      const result = await service.preview({
        instruction: '',
        sheetText: MAPPING_SHEET,
        targetColumn: '负责人',
        hintColumns: ['区域'],
      });
      expect(result).toMatchObject({ path: 'mapping', ok: true, suggestRule });
    });

    it('去重 >100 → 分批报价（不执行、不调 LLM）', async () => {
      const result = await service.preview({
        instruction: '',
        sheetText: makeWideSheet(101),
        targetColumn: '负责人',
        hintColumns: ['地区'],
      });
      expect(result).toMatchObject({
        path: 'batch',
        ok: true,
        emptyCount: 101,
        distinctCount: 101,
        batchCount: 2,
        batchRows: 100,
      });
      expect(mockInferFillMapping).not.toHaveBeenCalled();
    });

    it('targetSheet 不存在时抛业务错误（双 sheet 才触发，单 sheet 有容错命中）', async () => {
      const twoSheets = [
        'Sheet: 销售表',
        '地区,负责人',
        '北京,老王',
        'Sheet: 库存表',
        '物品,数量',
        '苹果,10',
      ].join('\n');
      await expect(
        service.preview({
          instruction: '',
          sheetText: twoSheets,
          targetColumn: '负责人',
          hintColumns: ['地区'],
          targetSheet: '不存在',
        }),
      ).rejects.toThrow('找不到工作表');
    });

    it('目标列不存在时抛业务错误（start 同样复用该解析）', () => {
      expect(() =>
        service.startBatchTask({
          instruction: '',
          sheetText: MAPPING_SHEET,
          targetColumn: '不存在的列',
          hintColumns: ['区域'],
        }),
      ).toThrow(TableOpsError);
    });

  });

  // ==================== 规则门禁（功能 5） ====================

  describe('规则门禁', () => {
    it('映射结果违反规则 → 整体拒绝并带违规明细', async () => {
      const svc = new SemanticFillService(
        makeRuleService([
          {
            id: 1,
            name: '负责人白名单',
            type: 'allowedValues',
            params: { column: '负责人', values: ['张三'] },
          },
        ]),
      );
      mockInferFillMapping.mockResolvedValueOnce(FULL_MAPPING);
      const result = await svc.preview({
        instruction: '',
        sheetText: MAPPING_SHEET,
        targetColumn: '负责人',
        hintColumns: ['区域'],
        documentId: 42,
      });
      if (result.ok !== false) throw new Error('应当被门禁拒绝');
      expect(result.message).toContain('违反表格规则');
      expect(result.ruleViolations.violations.length).toBeGreaterThan(0);
      expect(result.ruleViolations.violations[0]).toMatchObject({ column: '负责人' });
    });

    it('映射结果满足规则 → 正常通过', async () => {
      const svc = new SemanticFillService(
        makeRuleService([{ id: 1, name: '负责人必填', type: 'notEmpty', params: { column: '负责人' } }]),
      );
      mockInferFillMapping.mockResolvedValueOnce(FULL_MAPPING);
      const result = await svc.preview({
        instruction: '',
        sheetText: MAPPING_SHEET,
        targetColumn: '负责人',
        hintColumns: ['区域'],
      });
      expect(result).toMatchObject({ path: 'mapping', ok: true, appliedRows: 3 });
    });

    it('文档既有违规不拦截无关填充（门禁只拒绝新增违规）', async () => {
      // 区域列在填充前就有白名单违规（华北/华南 ∉ [华东]），但本次填充只动
      // 负责人列——既有违规不该连坐，填充应正常放行
      const svc = new SemanticFillService(
        makeRuleService([
          {
            id: 1,
            name: '区域白名单',
            type: 'allowedValues',
            params: { column: '区域', values: ['华东'] },
          },
        ]),
      );
      mockInferFillMapping.mockResolvedValueOnce(FULL_MAPPING);
      const result = await svc.preview({
        instruction: '',
        sheetText: MAPPING_SHEET,
        targetColumn: '负责人',
        hintColumns: ['区域'],
        documentId: 42,
      });
      expect(result).toMatchObject({ path: 'mapping', ok: true, appliedRows: 3 });
    });

    it('既有违规之外又新增违规 → 拒绝，文案区分新增明细与既有数量', async () => {
      const svc = new SemanticFillService(
        makeRuleService([
          {
            id: 1,
            name: '区域白名单',
            type: 'allowedValues',
            params: { column: '区域', values: ['华东'] },
          },
          {
            id: 2,
            name: '负责人白名单',
            type: 'allowedValues',
            params: { column: '负责人', values: ['张三'] },
          },
        ]),
      );
      mockInferFillMapping.mockResolvedValueOnce(FULL_MAPPING);
      const result = await svc.preview({
        instruction: '',
        sheetText: MAPPING_SHEET,
        targetColumn: '负责人',
        hintColumns: ['区域'],
        documentId: 42,
      });
      if (result.ok !== false) throw new Error('应当被门禁拒绝');
      expect(result.message).toContain('新增');
      expect(result.message).toContain('既有违规');
      // 拒绝清单只含本次填充引入的违规（负责人列），不含区域列的既有违规
      expect(result.ruleViolations.violations.length).toBeGreaterThan(0);
      expect(result.ruleViolations.violations.every((v) => v.column === '负责人')).toBe(true);
    });

    it('目标列命中取值白名单规则 → 约束注入填充提示词（事前遵守）', async () => {
      const svc = new SemanticFillService(
        makeRuleService([
          {
            id: 1,
            name: '负责人白名单',
            type: 'allowedValues',
            params: { column: '负责人', values: ['张三', '李四'] },
          },
        ]),
      );
      mockInferFillMapping.mockResolvedValueOnce(FULL_MAPPING);
      await svc.preview({
        instruction: '',
        sheetText: MAPPING_SHEET,
        targetColumn: '负责人',
        hintColumns: ['区域'],
        documentId: 42,
      });
      const constraints = mockInferFillMapping.mock.calls[0][2] as string | undefined;
      expect(constraints).toBeDefined();
      expect(constraints).toContain('只能填');
      expect(constraints).toContain('张三');
    });

    it('规则加载失败 → 记日志放行（规则器不拖垮填充主链路）', async () => {
      const svc = new SemanticFillService(makeRuleService(new Error('db down')));
      mockInferFillMapping.mockResolvedValueOnce(FULL_MAPPING);
      const result = await svc.preview({
        instruction: '',
        sheetText: MAPPING_SHEET,
        targetColumn: '负责人',
        hintColumns: ['区域'],
      });
      expect(result).toMatchObject({ path: 'mapping', ok: true, filledText: MAPPING_FILLED_TEXT });
    });

    it('分批任务终态门禁拒绝 → failed、无 filledText（违规数据不进编辑器）', async () => {
      const svc = new SemanticFillService(
        makeRuleService([
          {
            id: 1,
            name: '负责人白名单',
            type: 'allowedValues',
            params: { column: '负责人', values: ['合法值'] },
          },
        ]),
      );
      mockInferBatchFill.mockResolvedValueOnce({ fills: [{ row: 1, value: '违规值' }] });
      const res = svc.startBatchTask({
        instruction: '',
        sheetText: SMALL_SHEET,
        targetColumn: '负责人',
        hintColumns: ['地区'],
        documentId: 42,
      });
      const status = await waitForTerminal(svc, res.taskId);
      expect(status.status).toBe('failed');
      expect(status.error).toContain('违反表格规则');
      expect(status.filledText).toBeUndefined();
      expect(status.completedBatches).toBe(1); // 批本身全部完成，只是门禁拒绝
    });
  });

  // ==================== 分批任务 ====================

  describe('分批任务', () => {
    it('单批任务完整跑通 → done 且结果过门禁', async () => {
      mockInferBatchFill.mockResolvedValueOnce({
        fills: [
          { row: 1, value: '老张' },
          { row: 2, value: '老李' },
        ],
      });
      const text = ['Sheet: t', '负责人,地区', ',北京', ',上海'].join('\n');
      const res = service.startBatchTask({
        instruction: '',
        sheetText: text,
        targetColumn: '负责人',
        hintColumns: ['地区'],
      });
      expect(res.batchCount).toBe(1);
      expect(res.emptyCount).toBe(2);
      const status = await waitForTerminal(service, res.taskId);
      expect(status.status).toBe('done');
      expect(status.appliedRows).toBe(2);
      expect(status.completedBatches).toBe(1);
      expect(status.progress).toBe(1);
      expect(status.filledText).toBe(['Sheet: t', '负责人,地区', '老张,北京', '老李,上海'].join('\n'));
    });

    it('250 行 → 3 批逐批执行，进度与结果完整', async () => {
      mockInferBatchFill.mockImplementation(async (rowsText: string) => fillsForRowsText(rowsText));
      const res = service.startBatchTask({
        instruction: '',
        sheetText: makeWideSheet(250),
        targetColumn: '负责人',
        hintColumns: ['地区'],
      });
      expect(res.batchCount).toBe(3);
      const status = await waitForTerminal(service, res.taskId);
      expect(status.status).toBe('done');
      expect(status.completedBatches).toBe(3);
      expect(status.appliedRows).toBe(250);
      expect(status.filledText).toContain('填250,r250'); // 末行已填
      expect(mockInferBatchFill).toHaveBeenCalledTimes(3);
    });

    it('批内缺行 → 该批判失败，已完成批次的结果保留可应用', async () => {
      mockInferBatchFill
        .mockImplementationOnce(async (rowsText: string) => fillsForRowsText(rowsText)) // 批 1 成功
        .mockResolvedValueOnce({ fills: [{ row: 101, value: 'x' }] }); // 批 2 缺 99 行
      const res = service.startBatchTask({
        instruction: '',
        sheetText: makeWideSheet(250),
        targetColumn: '负责人',
        hintColumns: ['地区'],
      });
      const status = await waitForTerminal(service, res.taskId);
      expect(status.status).toBe('failed');
      expect(status.failedBatch).toBe(2);
      expect(status.completedBatches).toBe(1);
      expect(status.appliedRows).toBe(100);
      expect(status.error).toContain('未给出本批全部行的填充值');
      expect(status.filledText).toBeDefined();
      expect(status.filledText).toContain('填1,r1');
      expect(status.filledText).not.toContain('填101'); // 批 2 未产出
    });

    it('协作式取消：当前批完成后停止，已完成批次结果保留', async () => {
      const taskIdRef: { value: string } = { value: '' };
      mockInferBatchFill.mockImplementationOnce(async (rowsText: string) => {
        // startBatchTask 内部同步调起批 1 的 LLM（此刻 taskId 还没返回），
        // 用微任务延迟到 startBatchTask 返回、taskIdRef 赋值之后再请求取消——
        // 取消标记在批 1 应用完、批 2 开始前被检测到
        queueMicrotask(() => service.cancelTask(taskIdRef.value));
        return fillsForRowsText(rowsText);
      });
      const res = service.startBatchTask({
        instruction: '',
        sheetText: makeWideSheet(250),
        targetColumn: '负责人',
        hintColumns: ['地区'],
      });
      taskIdRef.value = res.taskId;
      const status = await waitForTerminal(service, res.taskId);
      expect(status.status).toBe('cancelled');
      expect(status.cancelRequested).toBe(true);
      expect(status.completedBatches).toBe(1);
      expect(status.appliedRows).toBe(100);
      expect(status.filledText).toContain('填1,r1');
      expect(status.filledText).not.toContain('填101');
      expect(mockInferBatchFill).toHaveBeenCalledTimes(1); // 批 2 未再调用 LLM
    });

    it('并发上限：已有 3 个 running 任务时拒绝新任务', async () => {
      const deferreds: Array<(v: BatchFillOutput) => void> = [];
      mockInferBatchFill.mockImplementation(
        () => new Promise<BatchFillOutput>((resolve) => deferreds.push(resolve)),
      );
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push(
          service.startBatchTask({
            instruction: '',
            sheetText: SMALL_SHEET,
            targetColumn: '负责人',
            hintColumns: ['地区'],
          }).taskId,
        );
      }
      expect(() =>
        service.startBatchTask({
          instruction: '',
          sheetText: SMALL_SHEET,
          targetColumn: '负责人',
          hintColumns: ['地区'],
        }),
      ).toThrow('填充任务在进行中');
      // 放行全部挂起的批次，确认任务都能正常收尾（不悬挂测试进程）。
      // 不依赖微任务时序：runTask 异步启动，startBatchTask 返回时 inferBatchFill
      // 未必已被调用——等 3 个 deferred 都挂上再放行
      const waitUntil = async (cond: () => boolean): Promise<void> => {
        const deadline = Date.now() + 2000;
        while (!cond()) {
          if (Date.now() > deadline) throw new Error('等待批次 LLM 调用发起超时');
          await new Promise((r) => setTimeout(r, 5));
        }
      };
      await waitUntil(() => deferreds.length === 3);
      for (const resolve of deferreds) resolve({ fills: [{ row: 1, value: 'x' }] });
      for (const id of ids) {
        const status = await waitForTerminal(service, id);
        expect(status.status).toBe('done');
      }
    });

    it('任务查询与取消的边界：不存在返回 null / 终态无需取消', async () => {
      expect(service.getTaskStatus('nonexistent')).toBeNull();
      expect(service.cancelTask('nonexistent').cancelled).toBe(false);

      mockInferBatchFill.mockResolvedValueOnce({ fills: [{ row: 1, value: 'x' }] });
      const res = service.startBatchTask({
        instruction: '',
        sheetText: SMALL_SHEET,
        targetColumn: '负责人',
        hintColumns: ['地区'],
      });
      await waitForTerminal(service, res.taskId);
      expect(service.cancelTask(res.taskId).cancelled).toBe(false); // 已是终态
      expect(service.cancelTask(res.taskId).message).toContain('终态');
    });
  });

  // ==================== 跨表参照（referenceSheet） ====================

  describe('跨表填充 referenceSheet', () => {
    /** 目标表 + 参照表的双 sheet 文档：汇总表类型列空缺，明细表有产品→类型对照 */
    const CROSS_DOC = [
      'Sheet: 销售汇总',
      '产品,类型',
      '冰箱,',
      '洗衣机,',
      'Sheet: 销售明细',
      '产品,类型,单价',
      '冰箱,家电,1200',
      '洗衣机,家电,800',
    ].join('\n');

    it('preview 传 referenceSheet → 参照表对照文本注入 inferFillMapping', async () => {
      mockInferFillMapping.mockResolvedValueOnce({
        mapping: [
          { from: '冰箱', to: '家电' },
          { from: '洗衣机', to: '家电' },
        ],
      });
      await service.preview({
        instruction: '按销售明细补类型',
        sheetText: CROSS_DOC,
        targetColumn: '类型',
        hintColumns: ['产品'],
        targetSheet: '销售汇总',
        referenceSheet: '销售明细',
      });
      const crossReference = mockInferFillMapping.mock.calls[0][3] as string | undefined;
      expect(crossReference).toBeDefined();
      expect(crossReference).toContain('产品=冰箱 → 类型=家电，单价=1200');
      expect(crossReference).toContain('产品=洗衣机 → 类型=家电，单价=800');
    });

    it('参照工作表不存在 → 抛业务错误（不静默忽略参照要求）', async () => {
      const err = await service
        .preview({
          instruction: '',
          sheetText: CROSS_DOC,
          targetColumn: '类型',
          hintColumns: ['产品'],
          targetSheet: '销售汇总',
          referenceSheet: '不存在的表',
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TableOpsError);
      expect((err as Error).message).toContain('找不到参照工作表');
    });

    it('分批报价回传 targetSheet/referenceSheet（前端 start 时原样带回）', async () => {
      const result = await service.preview({
        instruction: '',
        sheetText: makeWideSheet(101),
        targetColumn: '负责人',
        hintColumns: ['地区'],
        targetSheet: 't',
        referenceSheet: '明细',
      });
      expect(result).toMatchObject({
        path: 'batch',
        targetSheet: 't',
        referenceSheet: '明细',
      });
    });
  });
});
