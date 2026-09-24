/**
 * 引用锚点匹配（RAG 可验证生成 —— 引用定位闭环）
 *
 * 职责：给定文档中各文本块的纯文本与一段引用锚点，找出锚点落在哪个块。
 * 抽成纯函数的原因：
 *   1. 阶梯缩短重试是多分支逻辑，需要单测保护（避免后续调整档位时静默回归）
 *   2. 与 Tiptap 编辑器解耦，调用方只需负责"取出文本块 + 定位 DOM"
 */

/**
 * 锚点匹配长度阶梯：优先用长串精确匹配，失配时逐档缩短重试以提升容错。
 *
 * 为什么需要阶梯：PDF/Word 解析入库的文本与编辑器渲染文本常有细微差异
 * （表格被拍平、页眉页脚被剔除、多余空行被清理）。差异点若落在锚点靠后位置，
 * 长串必然失配，缩短匹配串后仍有机会命中；若差异落在最前面则任何档位都救不了，
 * 此时由调用方降级为普通打开并给出提示。
 */
export const ANCHOR_MATCH_LENGTHS = [60, 40, 25];

/** 未命中的返回值 */
export const ANCHOR_NOT_FOUND = -1;

/**
 * 去除全部空白字符，用于消除换行/空格差异带来的匹配噪声。
 * 调用方取出文本块后应先经此归一化，再传入 findAnchorBlockIndex。
 */
export function normalizeAnchorText(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * 按长度阶梯查找锚点所在的文本块下标。
 *
 * @param blockTexts 文档中各文本块的纯文本，**必须已归一化**（见 normalizeAnchorText）；
 *                   数组顺序即块在文档中的顺序，返回的下标可直接用于定位 DOM
 * @param anchor 原始锚点文本（内部会归一化，调用方无需预处理）
 * @returns 命中的块下标；全部档位失配或锚点为空时返回 ANCHOR_NOT_FOUND
 */
export function findAnchorBlockIndex(blockTexts: string[], anchor: string): number {
  const fullTarget = normalizeAnchorText(anchor);
  if (!fullTarget) return ANCHOR_NOT_FOUND;

  // 阶梯去重：锚点归一化后可能不足 60 字，此时多档会退化为同一长度，
  // 去重可避免对同一匹配串重复扫描全部文本块
  const lengths = [
    ...new Set(ANCHOR_MATCH_LENGTHS.map((len) => Math.min(len, fullTarget.length))),
  ];

  for (const len of lengths) {
    const target = fullTarget.slice(0, len);
    const index = blockTexts.findIndex((text) => text.includes(target));
    // 长档命中即返回，保证定位到的是最精确的匹配
    if (index >= 0) return index;
  }

  return ANCHOR_NOT_FOUND;
}
