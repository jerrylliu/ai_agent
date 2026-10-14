/**
 * table-ops.service.spec.ts - confirm 阶段 TOCTOU 防护测试
 *
 * 覆盖：confirm 的三重校验（baseSheetText 一致性 / hash / origin+live 实时文本）。
 * 拒绝分支在任何依赖（TableRuleService/SemanticFillService）被触碰之前返回，
 * 因此用占位对象构造服务即可；happy path 依赖 loadRulesSafe 的降级行为
 * （占位服务缺方法 → catch → 空规则数组），无需真实仓储。
 */
import { TableOpsService } from './table-ops.service';
import { hashSheetText } from '../fundamentals/table-ops/clarify';
import type { ClarifyPayload } from '../fundamentals/table-ops/clarify';
import type { Strategy } from '../fundamentals/table-ops/clarify';

/** 占位构造：TOCTOU 拒绝分支不触依赖；happy path 经 loadRulesSafe 降级 */
function makeService(): TableOpsService {
  return new TableOpsService(
    {} as unknown as ConstructorParameters<typeof TableOpsService>[0],
    {} as unknown as ConstructorParameters<typeof TableOpsService>[1],
  );
}

const SHEET_TEXT = 'Sheet: 表1\n名称,数量\n椅子,\n桌子,\n';

/** Case A 载荷：baseSheetText = 发起时文本（编辑器里可见，二者相同） */
function caseAPayload(text: string): ClarifyPayload {
  return {
    kind: 'fill-source',
    question: '如何填充空缺？',
    baseSheetText: text,
    baseSheetTextHash: hashSheetText(text),
    originSheetTextHash: hashSheetText(text),
    baseOps: [],
  };
}

describe('TableOpsService.confirm - TOCTOU 防护', () => {
  it('Case A：编辑器文本与发起时不一致（卡片停留期间被编辑）→ 拒绝', async () => {
    const svc = makeService();
    const edited = `${SHEET_TEXT}沙发,\n`;
    const result = await svc.confirm({
      sheetText: edited, // 用户手改后的实时文本（未保存也算）
      sheetTextHash: hashSheetText(SHEET_TEXT),
      liveSheetText: edited,
      clarify: caseAPayload(SHEET_TEXT),
      strategies: [{ type: 'fill-constant', targetColumn: '数量', value: '5' }],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('请重新发起指令');
  });

  it('Case A：hash 不匹配 → 拒绝', async () => {
    const svc = makeService();
    const result = await svc.confirm({
      sheetText: SHEET_TEXT,
      sheetTextHash: 'deadbeef',
      clarify: caseAPayload(SHEET_TEXT),
      strategies: [{ type: 'fill-constant', targetColumn: '数量', value: '5' }],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('请重新发起指令');
  });

  it('Case B（有前缀 op）：liveSheetText 与 originSheetTextHash 不匹配 → 拒绝', async () => {
    const svc = makeService();
    // 中间态基底（编辑器里没有）+ 发起时原文 hash；实时文本已被用户改动
    const originText = 'Sheet: 表1\n名称,数量\n椅子,\n';
    const result = await svc.confirm({
      sheetText: 'Sheet: 表1\n名称,数量a,状态\n椅子,,\n', // 前缀 addColumn 后的中间态
      sheetTextHash: hashSheetText('Sheet: 表1\n名称,数量a,状态\n椅子,,\n'),
      liveSheetText: `${originText}沙发,\n`, // 卡片停留期间新增了一行
      clarify: {
        kind: 'fill-source',
        question: '如何填充？',
        baseSheetText: 'Sheet: 表1\n名称,数量a,状态\n椅子,,\n',
        baseSheetTextHash: hashSheetText('Sheet: 表1\n名称,数量a,状态\n椅子,,\n'),
        originSheetTextHash: hashSheetText(originText),
        baseOps: [{ type: 'addColumn', header: '状态' }],
      },
      strategies: [{ type: 'fill-constant', targetColumn: '状态', value: '正常' }],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('请重新发起指令');
  });

  it('Case A 全一致 → 通过校验，编译执行返回新文本', async () => {
    const svc = makeService();
    const result = await svc.confirm({
      sheetText: SHEET_TEXT,
      sheetTextHash: hashSheetText(SHEET_TEXT),
      liveSheetText: SHEET_TEXT,
      clarify: caseAPayload(SHEET_TEXT),
      strategies: [{ type: 'fill-constant', targetColumn: '数量', value: '5' }],
    });
    expect(result.ok).toBe(true);
    expect(result.sheetText).toContain('椅子,5');
    expect(result.sheetText).toContain('桌子,5');
  });

  it('空 strategies 被 schema 拦截（min(1)），这里验证全 keep-empty 跳过路径', async () => {
    const svc = makeService();
    // keep-empty 编译为空 op 集 → 服务端返回"已按你的选择跳过"
    const strategies: Strategy[] = [{ type: 'keep-empty' }];
    const result = await svc.confirm({
      sheetText: SHEET_TEXT,
      sheetTextHash: hashSheetText(SHEET_TEXT),
      clarify: caseAPayload(SHEET_TEXT),
      strategies,
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('跳过');
  });
});
