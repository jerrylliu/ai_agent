/**
 * document-parser.sheet-structure.spec.ts - 上传时表格结构自动检测测试
 *
 * 覆盖：buildSheetBlockText 的 HeaderRow/TotalRow 保守自动识别，
 *       核心回归用例为"大标题 + 日期范围两行连续说明行 + 第 3 行真表头"
 *       的真实报表形态（excel-editor-test.xlsx 的汇总 sheet）。
 */
import { buildSheetBlockText, detectReportHeaderRow } from './document-parser';

describe('detectReportHeaderRow / buildSheetBlockText - 表头锚定', () => {
  it('两行连续说明行（大标题 + 日期）→ 表头锚定第 3 行（真实用户文件形态回归）', () => {
    // 此形态曾被旧启发式漏判（旧逻辑只认"1 行说明 + 表头"），导致前端把
    // 大标题行当表头渲染
    const csv = [
      '销售汇总报告,',
      '2026-10-01 ~ 2026-10-11,',
      '产品类别,金额小计',
      '电子产品,24393',
      '电脑配件,79215',
      '办公家具,9798',
      '总计,113406',
    ].join('\n');

    expect(detectReportHeaderRow(csv)).toBe(3);
    const block = buildSheetBlockText('汇总', csv);
    expect(block).toContain('HeaderRow: 3');
    // 汇总行锚定基于表头行号："总计"是表头（第 3 行）后的第 4 个内容行
    expect(block).toContain('TotalRow: 7');
    // 指令在 CSV 之前（块首指令区）
    expect(block.indexOf('HeaderRow: 3')).toBeLessThan(block.indexOf('产品类别'));
  });

  it('单行说明 + 表头 → 表头锚定第 2 行（原有行为保持）', () => {
    const csv = ['销售汇总报告,', '产品类别,金额小计', '电子产品,24393', '总计,24393'].join('\n');
    expect(detectReportHeaderRow(csv)).toBe(2);
    const block = buildSheetBlockText('汇总', csv);
    expect(block).toContain('HeaderRow: 2');
    expect(block).toContain('TotalRow: 4');
  });

  it('常规表（首行即表头）→ 不产生 HeaderRow 指令', () => {
    const csv = ['名称,数量', '椅子,10', '桌子,5'].join('\n');
    expect(detectReportHeaderRow(csv)).toBe(null);
    const block = buildSheetBlockText('明细', csv);
    expect(block).not.toContain('HeaderRow');
    expect(block).not.toContain('TotalRow');
  });

  it('单列表格 → 不触发（防误判）', () => {
    const csv = ['姓名', '张三', '李四'].join('\n');
    expect(detectReportHeaderRow(csv)).toBe(null);
  });

  it('说明行含引号包裹的逗号单元格 → 仍按单非空格处理，锚定真实表头', () => {
    // SheetJS 产物中含逗号的单元格必带引号：说明行虽有逗号但只有 1 个非空格
    const csv = [
      '销售汇总报告,', // 1 非空格
      '"要点一,要点二",', // 引号包裹 → 仍是 1 非空格说明行
      '产品类别,金额小计',
      '电子产品,24393',
    ].join('\n');
    expect(detectReportHeaderRow(csv)).toBe(3);
  });

  it('键值对落款行（多格）→ 视为说明行跳过，锚定真实表头', () => {
    // 旧逻辑盲区：制表人/审核人占 2 个格子，会被误判成表头
    const csv = [
      '制表人:张三,审核人:李四',
      '产品类别,金额小计',
      '电子产品,24393',
      '总计,24393',
    ].join('\n');
    expect(detectReportHeaderRow(csv)).toBe(2);
  });

  it('单格说明行与键值对落款行混合 → 继续向下锚定', () => {
    const csv = [
      '销售汇总报告,',
      '制表人:张三,审核人:李四',
      '产品类别,金额小计',
      '电子产品,24393',
    ].join('\n');
    expect(detectReportHeaderRow(csv)).toBe(3);
  });

  it('首个非说明行含纯数字格（无表头数据表）→ 放弃猜测', () => {
    const csv = ['张三,25', '李四,30', '王五,40'].join('\n');
    expect(detectReportHeaderRow(csv)).toBe(null);
  });

  it('候选行格子重复 → 放弃猜测', () => {
    const csv = ['备注,备注', 'a,b', 'c,d'].join('\n');
    expect(detectReportHeaderRow(csv)).toBe(null);
  });

  it('时间值行（键为纯数字，如 10:30）不算键值对说明行，不产生指令', () => {
    // 无表头排班表：首行是时间数据。若被当键值对跳过，第二行数据会被误锚定
    const csv = ['10:30,11:45', '张三,出勤', '李四,缺勤'].join('\n');
    expect(detectReportHeaderRow(csv)).toBe(null);
  });

  it('不足 3 行 → 不触发', () => {
    expect(detectReportHeaderRow('标题,\n产品类别,金额小计')).toBe(null);
  });
});
