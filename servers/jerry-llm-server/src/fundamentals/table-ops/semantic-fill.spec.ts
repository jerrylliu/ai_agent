/**
 * table-ops/semantic-fill.spec.ts - 语义填充纯函数层测试
 *
 * 覆盖：空缺统计（依据列自动兜底/全空依据行跳过/去重截断但总数真实）、
 *       映射校验与应用（多列拼接键/非空行保留/应用计数）、
 *       跨表参照（同名列对照/缺列跳过/无匹配返回 undefined/行数上限）、
 *       分批切分与报价、批输入文本格式、批级校验（缺行即失败）、
 *       批结果应用（行号越界抛错）。
 */
import {
  analyzeFillGaps,
  fillMappingMissing,
  applyFillMapping,
  splitBatches,
  countBatches,
  buildBatchRowsText,
  batchFillMissingRows,
  applyBatchFills,
  buildCrossSheetReference,
  MAX_DISTINCT_FOR_MAPPING,
  MAX_MAPPING_ENTRIES,
  type FillMappingOutput,
  type BatchFillOutput,
} from './semantic-fill';
import { parseSheetData, TableOpsError, type SheetData } from './executor';

/** 快捷构造：单 sheet 的 sheetText（注意空单元格行要用 ',' 而非 ''——空行会被解析跳过） */
function singleSheetText(headers: string, ...rows: string[]): string {
  return `Sheet: 测试\n${headers}\n${rows.join('\n')}`;
}

/** 快捷构造：直接构建 SheetData（单元测试精确控制，不经过文本解析） */
function makeSheet(headers: string[], rows: string[][]): SheetData {
  return {
    name: '测试',
    headerRowIndex: 1,
    totalRowIndexes: [],
    preambleRows: [],
    headers,
    rows,
    lookupFills: [],
  };
}

// ==================== 汇总行声明式排除 ====================

describe('汇总行声明式排除（totalRowIndexes）', () => {
  /** 带已声明汇总行的表：总计在第 4 数据行（内容行 5），目标列销售员空缺 */
  function makeTotalSheet(): SheetData {
    return parseSheetData(
      [
        'Sheet: 测试',
        'TotalRow: 5',
        '产品,销售员,销售额',
        '办公椅,,1400',
        '办公桌,,800',
        '显示器,,3600',
        '总计,,5800',
      ].join('\n'),
    )[0];
  }

  it('analyzeFillGaps：总行空缺不进统计（即使它的依据列有值）', () => {
    const sheet = makeTotalSheet();
    const stats = analyzeFillGaps(sheet, '销售员', ['产品']);
    expect(stats.emptyRowIndexes).toEqual([1, 2, 3]);
    expect(stats.distinctBasisValues).toEqual(['办公椅', '办公桌', '显示器']);
    expect(stats.distinctCount).toBe(3);
  });

  it('applyFillMapping：总行依据值在映射中也不写入（应用阶段二次拦截）', () => {
    const sheet = makeTotalSheet();
    const mapping = new Map<string, string>([
      ['办公椅', '张三'],
      ['办公桌', '李四'],
      ['显示器', '王五'],
      ['总计', '赵六'], // 总行的依据值——声明式闸门必须拦下它
    ]);
    const applied = applyFillMapping(sheet, '销售员', ['产品'], mapping);
    expect(applied).toBe(3);
    expect(sheet.rows[3]).toEqual(['总计', '', '5800']); // 总行原样（销售员仍空缺）
  });

  it('buildCrossSheetReference：总行不作为跨表参照样本', () => {
    const target = parseSheetData('Sheet: 目标\nTotalRow: 3\n产品,销售员\n办公椅,\n总计,6\n')[0];
    const ref = parseSheetData('Sheet: 参照\n产品,类型\n办公椅,家电\n总计,6\n')[0];
    const text = buildCrossSheetReference(target, ref, ['产品']);
    // 若总行未排除会多出 "产品=总计 → 类型=6"
    expect(text).toBe('产品=办公椅 → 类型=家电');
  });
});

// ==================== analyzeFillGaps 空缺统计 ====================

describe('analyzeFillGaps - 基本统计', () => {
  it('目标列为空的行被找出，行号 1 起不含表头；非空行忽略', () => {
    const sheet = parseSheetData(
      singleSheetText('城市,区域,销售额', '北京,,100', '上海,华东,200', '广州,,300'),
    )[0];
    const stats = analyzeFillGaps(sheet, '区域', ['城市']);
    expect(stats.targetColumn).toBe('区域');
    expect(stats.hintColumns).toEqual(['城市']);
    expect(stats.emptyRowIndexes).toEqual([1, 3]);
    expect(stats.distinctBasisValues).toEqual(['北京', '广州']);
    expect(stats.distinctCount).toBe(2);
  });

  it('多依据列时去重键用 " | " 拼接，样本格式为 "列=值，列=值"', () => {
    const sheet = makeSheet(
      ['城市', '门店', '区域'],
      [
        ['北京', 'A店', ''],
        ['北京', 'B店', ''],
        ['北京', 'A店', ''], // 与第 1 行依据值完全相同 → 去重
      ],
    );
    const stats = analyzeFillGaps(sheet, '区域', ['城市', '门店']);
    expect(stats.emptyRowIndexes).toEqual([1, 2, 3]);
    expect(stats.distinctBasisValues).toEqual(['北京 | A店', '北京 | B店']);
    expect(stats.rowSamples.get('北京 | A店')).toBe('城市=北京，门店=A店');
    expect(stats.rowSamples.get('北京 | B店')).toBe('城市=北京，门店=B店');
  });

  it('单依据列的去重键不含拼接符，直接用原值', () => {
    const sheet = makeSheet(['城市', '区域'], [['北京', ''], ['上海', '']]);
    const stats = analyzeFillGaps(sheet, '区域', ['城市']);
    expect(stats.distinctBasisValues).toEqual(['北京', '上海']);
  });
});

describe('analyzeFillGaps - 兜底与边界', () => {
  it('hintColumns 为空时自动取前 3 个非目标列', () => {
    const sheet = makeSheet(
      ['A', 'B', 'C', 'D', '目标'],
      [['a1', 'b1', 'c1', 'd1', '']],
    );
    const stats = analyzeFillGaps(sheet, '目标', []);
    expect(stats.hintColumns).toEqual(['A', 'B', 'C']);
  });

  it('表中只有目标列一列 → 抛 TableOpsError（没有推断依据）', () => {
    const sheet = makeSheet(['目标'], [['']]);
    expect(() => analyzeFillGaps(sheet, '目标', [])).toThrow(TableOpsError);
  });

  it('指定的依据列不存在 → 抛 TableOpsError', () => {
    const sheet = makeSheet(['城市', '区域'], [['北京', '']]);
    expect(() => analyzeFillGaps(sheet, '区域', ['不存在的列'])).toThrow(TableOpsError);
  });

  it('目标列不存在 → 抛 TableOpsError', () => {
    const sheet = makeSheet(['城市'], [['北京']]);
    expect(() => analyzeFillGaps(sheet, '区域', [])).toThrow(TableOpsError);
  });

  it('依据值全空的行：仍在 emptyRowIndexes 中，但不进去重清单（推不出来）', () => {
    const sheet = makeSheet(
      ['城市', '区域'],
      [
        ['北京', ''],
        ['', ''], // 依据列（城市）也为空
        ['上海', ''],
      ],
    );
    const stats = analyzeFillGaps(sheet, '区域', ['城市']);
    expect(stats.emptyRowIndexes).toEqual([1, 2, 3]);
    expect(stats.distinctBasisValues).toEqual(['北京', '上海']);
    expect(stats.distinctCount).toBe(2);
  });

  it('去重值超过 MAX_MAPPING_ENTRIES：清单截断但 distinctCount 是真实总数', () => {
    const rows: string[][] = [];
    for (let i = 0; i < 250; i++) {
      rows.push([`值${i}`, '']);
    }
    const sheet = makeSheet(['城市', '区域'], rows);
    const stats = analyzeFillGaps(sheet, '区域', ['城市']);
    expect(MAX_MAPPING_ENTRIES).toBe(200);
    expect(stats.distinctBasisValues).toHaveLength(200);
    expect(stats.distinctCount).toBe(250);
  });

  it('目标列空单元格含纯空格也视为空', () => {
    const sheet = makeSheet(['城市', '区域'], [['北京', '  '], ['上海', '']]);
    const stats = analyzeFillGaps(sheet, '区域', ['城市']);
    expect(stats.emptyRowIndexes).toEqual([1, 2]);
  });
});

// ==================== fillMappingMissing 映射校验 ====================

describe('fillMappingMissing', () => {
  const stats = analyzeFillGaps(
    makeSheet(['城市', '区域'], [['北京', ''], ['上海', ''], ['广州', '']]),
    '区域',
    ['城市'],
  );

  it('映射未覆盖的依据值返回缺失清单', () => {
    const mapping: FillMappingOutput['mapping'] = [
      { from: '北京', to: '华北' },
    ];
    expect(fillMappingMissing(stats, mapping)).toEqual(['上海', '广州']);
  });

  it('映射全覆盖 → 空数组（通过）', () => {
    const mapping: FillMappingOutput['mapping'] = [
      { from: '北京', to: '华北' },
      { from: '上海', to: '华东' },
      { from: '广州', to: '华南' },
    ];
    expect(fillMappingMissing(stats, mapping)).toEqual([]);
  });

  it('映射含多余条目（不在去重清单里）不影响校验', () => {
    const mapping: FillMappingOutput['mapping'] = [
      { from: '北京', to: '华北' },
      { from: '上海', to: '华东' },
      { from: '广州', to: '华南' },
      { from: '深圳', to: '华南' },
    ];
    expect(fillMappingMissing(stats, mapping)).toEqual([]);
  });
});

// ==================== applyFillMapping 映射应用 ====================

describe('applyFillMapping', () => {
  it('按映射刷目标列空缺行，返回应用行数；非空行保留原值', () => {
    const sheet = makeSheet(
      ['城市', '区域'],
      [
        ['北京', ''],
        ['上海', '已有值'],
        ['广州', ''],
        ['北京', ''], // 同依据值第二行也刷
      ],
    );
    const mapping = new Map([
      ['北京', '华北'],
      ['广州', '华南'],
    ]);
    const applied = applyFillMapping(sheet, '区域', ['城市'], mapping);
    expect(applied).toBe(3);
    expect(sheet.rows[0][1]).toBe('华北');
    expect(sheet.rows[1][1]).toBe('已有值'); // 非空不动
    expect(sheet.rows[2][1]).toBe('华南');
    expect(sheet.rows[3][1]).toBe('华北');
  });

  it('多依据列：键按 " | " 拼接匹配', () => {
    const sheet = makeSheet(
      ['城市', '门店', '区域'],
      [['北京', 'A店', ''], ['北京', 'B店', '']],
    );
    const mapping = new Map([
      ['北京 | A店', '华北一区'],
      ['北京 | B店', '华北二区'],
    ]);
    const applied = applyFillMapping(sheet, '区域', ['城市', '门店'], mapping);
    expect(applied).toBe(2);
    expect(sheet.rows[0][2]).toBe('华北一区');
    expect(sheet.rows[1][2]).toBe('华北二区');
  });

  it('映射里没有的依据值 → 跳过该行不写入（调用方负责前置校验）', () => {
    const sheet = makeSheet(['城市', '区域'], [['北京', ''], ['广州', '']]);
    const mapping = new Map([['北京', '华北']]);
    const applied = applyFillMapping(sheet, '区域', ['城市'], mapping);
    expect(applied).toBe(1);
    expect(sheet.rows[0][1]).toBe('华北');
    expect(sheet.rows[1][1]).toBe(''); // 广州无映射，保留空
  });

  it('映射值为空白字符串 → 视为无效跳过', () => {
    const sheet = makeSheet(['城市', '区域'], [['北京', '']]);
    const mapping = new Map([['北京', '  ']]);
    const applied = applyFillMapping(sheet, '区域', ['城市'], mapping);
    expect(applied).toBe(0);
    expect(sheet.rows[0][1]).toBe('');
  });
});

// ==================== splitBatches / countBatches 分批 ====================

describe('splitBatches', () => {
  it('250 行按 100 切 → 100/100/50 三批，批内行号升序', () => {
    const rowIndexes = Array.from({ length: 250 }, (_, i) => i + 1);
    const batches = splitBatches(rowIndexes);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(100);
    expect(batches[0][0]).toBe(1);
    expect(batches[1][0]).toBe(101);
    expect(batches[2]).toHaveLength(50);
    expect(batches[2][49]).toBe(250);
  });

  it('恰好整批 → 不产生空批', () => {
    const batches = splitBatches([1, 2, 3, 4], 2);
    expect(batches).toEqual([[1, 2], [3, 4]]);
  });

  it('空行号清单 → 空批数组', () => {
    expect(splitBatches([])).toEqual([]);
  });

  it('自定义批大小生效', () => {
    const batches = splitBatches([1, 2, 3, 4, 5], 2);
    expect(batches).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('countBatches', () => {
  it('0 行按 1 批报（避免除零/负数）', () => {
    expect(countBatches(0)).toBe(1);
  });
  it('100 行 1 批、101 行 2 批、250 行 3 批', () => {
    expect(countBatches(100)).toBe(1);
    expect(countBatches(101)).toBe(2);
    expect(countBatches(250)).toBe(3);
  });
});

// ==================== buildBatchRowsText 批输入文本 ====================

describe('buildBatchRowsText', () => {
  it('每行格式 "第 N 行：列=值，列=值（目标列为空）"，N 为数据行号', () => {
    const sheet = makeSheet(
      ['城市', '门店', '区域'],
      [
        ['北京', 'A店', ''],
        ['上海', 'B店', ''],
      ],
    );
    const text = buildBatchRowsText(sheet, [1, 2], '区域', ['城市', '门店']);
    expect(text).toBe(
      '第 1 行：城市=北京，门店=A店（区域为空）\n第 2 行：城市=上海，门店=B店（区域为空）',
    );
  });

  it('行号越界 → 输出占位提示（不抛错，LLM 输入侧宽容）', () => {
    const sheet = makeSheet(['城市', '区域'], [['北京', '']]);
    const text = buildBatchRowsText(sheet, [1, 5], '区域', ['城市']);
    expect(text).toContain('第 5 行：（行不存在）');
  });

  it('单元格值截断到 60 字符', () => {
    const longValue = '长'.repeat(100);
    const sheet = makeSheet(['城市', '区域'], [[longValue, '']]);
    const text = buildBatchRowsText(sheet, [1], '区域', ['城市']);
    expect(text).toContain('长'.repeat(60));
    expect(text).not.toContain('长'.repeat(61));
  });
});

// ==================== batchFillMissingRows 批级校验 ====================

describe('batchFillMissingRows', () => {
  it('LLM 漏给的行返回缺失清单', () => {
    const output: BatchFillOutput = {
      fills: [
        { row: 1, value: '华北' },
        { row: 3, value: '华南' },
      ],
    };
    expect(batchFillMissingRows([1, 2, 3], output)).toEqual([2]);
  });

  it('全部覆盖 → 空数组（通过）', () => {
    const output: BatchFillOutput = {
      fills: [
        { row: 1, value: '华北' },
        { row: 2, value: '华东' },
      ],
    };
    expect(batchFillMissingRows([1, 2], output)).toEqual([]);
  });

  it('LLM 多给的行号不在批内 → 忽略（只校验批内行）', () => {
    const output: BatchFillOutput = {
      fills: [
        { row: 1, value: '华北' },
        { row: 99, value: '多余' },
      ],
    };
    expect(batchFillMissingRows([1], output)).toEqual([]);
  });
});

// ==================== applyBatchFills 批结果应用 ====================

describe('applyBatchFills', () => {
  it('按行号写入目标列，返回应用行数', () => {
    const sheet = makeSheet(
      ['城市', '区域'],
      [
        ['北京', ''],
        ['上海', ''],
        ['广州', ''],
      ],
    );
    const applied = applyBatchFills(sheet, '区域', [
      { row: 2, value: '华东' },
      { row: 3, value: '华南' },
    ]);
    expect(applied).toBe(2);
    expect(sheet.rows[1][1]).toBe('华东');
    expect(sheet.rows[2][1]).toBe('华南');
    expect(sheet.rows[0][1]).toBe(''); // 未指定的行不动
  });

  it('行号越界 → 抛 TableOpsError（表格可能被并发修改）', () => {
    const sheet = makeSheet(['城市', '区域'], [['北京', '']]);
    expect(() =>
      applyBatchFills(sheet, '区域', [{ row: 9, value: '华北' }]),
    ).toThrow(TableOpsError);
  });

  it('空白填充值跳过不写入（但行号仍需存在）', () => {
    const sheet = makeSheet(['城市', '区域'], [['北京', '']]);
    const applied = applyBatchFills(sheet, '区域', [{ row: 1, value: '  ' }]);
    expect(applied).toBe(0);
    expect(sheet.rows[0][1]).toBe('');
  });
});

// ==================== 常量与实际数据流冒烟 ====================

describe('常量与冒烟', () => {
  it('去重上限常量为 100（映射/分批路径的分界线）', () => {
    expect(MAX_DISTINCT_FOR_MAPPING).toBe(100);
  });

  it('冒烟：analyzeFillGaps → fillMappingMissing → applyFillMapping 全链路', () => {
    const sheet = parseSheetData(
      singleSheetText(
        '城市,区域,销售额',
        '北京,,100',
        '上海,,200',
        '广州,,300',
        '深圳,华南,400', // 非空行
      ),
    )[0];
    const stats = analyzeFillGaps(sheet, '区域', ['城市']);
    expect(stats.distinctBasisValues).toEqual(['北京', '上海', '广州']);

    // LLM 漏了广州 → 校验发现缺失
    const partial: FillMappingOutput['mapping'] = [
      { from: '北京', to: '华北' },
      { from: '上海', to: '华东' },
    ];
    expect(fillMappingMissing(stats, partial)).toEqual(['广州']);

    // 补齐后应用
    const full = new Map([
      ['北京', '华北'],
      ['上海', '华东'],
      ['广州', '华南'],
    ]);
    const applied = applyFillMapping(sheet, '区域', ['城市'], full);
    expect(applied).toBe(3);
    expect(sheet.rows[0][1]).toBe('华北');
    expect(sheet.rows[2][1]).toBe('华南');
    expect(sheet.rows[3][1]).toBe('华南'); // 原有值保留
  });
});

// ==================== buildCrossSheetReference 跨表参照 ====================

describe('buildCrossSheetReference - 跨表对照文本', () => {
  const target = makeSheet(
    ['产品', '类型'],
    [
      ['冰箱', ''],
      ['洗衣机', ''],
      ['冰箱', ''], // 重复值去重
    ],
  );
  const reference = makeSheet(
    ['产品', '类型', '单价'],
    [
      ['冰箱', '家电', '1200'],
      ['洗衣机', '家电', '800'],
      ['电视', '家电', '3000'],
    ],
  );

  it('同名列逐值对照，输出 "列=值 → 其他列样本" 行', () => {
    const text = buildCrossSheetReference(target, reference, ['产品']);
    expect(text).toContain('产品=冰箱 → 类型=家电，单价=1200');
    expect(text).toContain('产品=洗衣机 → 类型=家电，单价=800');
    expect(text).not.toContain('电视'); // 目标表没有的值不出对照
  });

  it('重复取值去重（同一依据值只出一行对照）', () => {
    const text = buildCrossSheetReference(target, reference, ['产品']);
    expect((text ?? '').split('\n')).toHaveLength(2);
  });

  it('依据列在参照表缺同名列时跳过；全部缺列返回 undefined', () => {
    const noMatch = buildCrossSheetReference(target, reference, ['城市']);
    expect(noMatch).toBeUndefined();
  });

  it('参照表存在该列但值都对不上 → 返回 undefined（无参照价值）', () => {
    const emptyRef = makeSheet(['产品', '类型'], [['空调', '家电']]);
    expect(buildCrossSheetReference(target, emptyRef, ['产品'])).toBeUndefined();
  });

  it('maxLines 截断对照行数', () => {
    const bigTarget = makeSheet(
      ['产品', '类型'],
      Array.from({ length: 60 }, (_, i) => [`P${i}`, '']),
    );
    const bigRef = makeSheet(
      ['产品', '类型'],
      Array.from({ length: 60 }, (_, i) => [`P${i}`, 'T']),
    );
    const text = buildCrossSheetReference(bigTarget, bigRef, ['产品'], 5);
    expect((text ?? '').split('\n')).toHaveLength(5);
  });
});
