/**
 * 文档解析模块
 * 支持解析 TXT、PDF、Word (.docx)、Excel (.xlsx) 格式的文档
 * 提取纯文本内容用于向量化存储
 *
 * PDF 解析策略：
 * 1. 优先使用 MinerU 在线 API（支持图片/代码块/表格/公式，文件上传方式，无需内网穿透）
 * 2. MinerU 不可用或失败时降级到本地 pdfjs-dist（仅提取纯文本）
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'node:module';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { config } from './config';
import { logger } from './logger';
import { getMineruEffectiveConfig } from './runtime-config';
import type { ParsedDocument } from './image-extractor';
import { extractImagesFromMineru } from './image-extractor/pdf-mineru';
import { extractImagesFromPdfjs } from './image-extractor/pdf-pdfjs';
import { extractFromWord } from './image-extractor/word';
import { explainFormulas } from './formula-explainer';
import {
  detectScannedPages,
  isScannedPdfDetectionEnabled,
  type PdfDocumentLike,
} from './scanned-pdf-detector';

// --- pdfjs-dist 资源路径 ---
// 注意：pdfjs 要求 cMapUrl / standardFontDataUrl 必须以斜杠结尾，
// Windows 下 path.sep 是反斜杠，必须统一用正斜杠。
// 用 package.json 定位包根：legacy 构建位于 <包根>/legacy/build/ 子目录，
// 若从构建文件向上推会停在 legacy/ 层级，导致 cmaps / standard_fonts 找不到。
const PDFJS_ROOT_PATH = path.dirname(
  require.resolve('pdfjs-dist/package.json'),
);
const PDFJS_CMAP_URL =
  path.join(PDFJS_ROOT_PATH, 'cmaps').replace(/\\/g, '/') + '/';
const PDFJS_STANDARD_FONT_URL =
  path.join(PDFJS_ROOT_PATH, 'standard_fonts').replace(/\\/g, '/') + '/';

// --- DOMMatrix / DOMPoint polyfill ---
// pdf.js v6 的 canvas.js 在模块顶层执行 `new DOMMatrix()`，
// Node.js 没有这些浏览器 API，必须先 polyfill 再动态导入 pdfjs。
// 文本提取不走 canvas 渲染，polyfill 只需保证构造不报错。
function ensureBrowserApiPolyfill(): void {
  const g = globalThis as Record<string, unknown>;
  if (g.DOMMatrix) return;

  class DOMMatrix {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;
    m11 = 1;
    m12 = 0;
    m13 = 0;
    m14 = 0;
    m21 = 0;
    m22 = 1;
    m23 = 0;
    m24 = 0;
    m31 = 0;
    m32 = 0;
    m33 = 1;
    m34 = 0;
    m41 = 0;
    m42 = 0;
    m43 = 0;
    m44 = 1;
    constructor(_init?: unknown) {}
    multiply(): DOMMatrix {
      return new DOMMatrix();
    }
    multiplySelf(): DOMMatrix {
      return this;
    }
    scale(): DOMMatrix {
      return new DOMMatrix();
    }
    scaleSelf(): DOMMatrix {
      return this;
    }
    translate(): DOMMatrix {
      return new DOMMatrix();
    }
    translateSelf(): DOMMatrix {
      return this;
    }
    rotate(): DOMMatrix {
      return new DOMMatrix();
    }
    rotateSelf(): DOMMatrix {
      return this;
    }
    inverse(): DOMMatrix {
      return new DOMMatrix();
    }
    transformPoint(): { x: number; y: number; z: number; w: number } {
      return { x: 0, y: 0, z: 0, w: 1 };
    }
    toFloat32Array(): Float32Array {
      return new Float32Array(16);
    }
    toFloat64Array(): Float64Array {
      return new Float64Array(16);
    }
    toString(): string {
      return 'matrix(1, 0, 0, 1, 0, 0)';
    }
  }

  class DOMPoint {
    x = 0;
    y = 0;
    z = 0;
    w = 1;
    constructor(_x?: unknown, _y?: unknown, _z?: unknown, _w?: unknown) {}
    toPoint(): { x: number; y: number } {
      return { x: this.x, y: this.y };
    }
    matrixTransform(): DOMPoint {
      return new DOMPoint();
    }
  }

  g.DOMMatrix = DOMMatrix;
  g.DOMPoint = DOMPoint;
}

// --- 懒加载 pdfjs ---
type PdfjsModule = typeof import('pdfjs-dist');
let pdfjsLib: PdfjsModule | null = null;

async function getPdfjs(): Promise<PdfjsModule> {
  if (pdfjsLib) return pdfjsLib;
  ensureBrowserApiPolyfill();

  // polyfill Math.sumPrecise（pdf.js v6 使用，Node.js 22/24 可能缺失）
  const mathAny = Math as unknown as Record<string, unknown>;
  if (typeof mathAny.sumPrecise !== 'function') {
    mathAny.sumPrecise = function sumPrecise(values: number[]): number {
      let sum = 0;
      for (const v of values) sum += v;
      return sum;
    };
  }

  // 必须使用 legacy 构建：v6 现代构建运行时用了 Promise.try 等 ES2025 API，
  // Node.js 22 生产镜像上抛 "Promise.try is not a function" 且为未捕获异常，
  // 会直接击穿上传请求（甚至崩掉进程）。pdf.js 官方要求 Node.js 环境使用 legacy 构建，
  // 两者的模块导出面一致，仅编译目标语法不同。
  pdfjsLib =
    (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule;
  // 不使用 worker — Node.js 环境下 worker 线程缺少浏览器 API polyfill，
  // pdf.js 会自动降级为主线程 fake worker 模式，文本提取性能足够
  return pdfjsLib;
}

/**
 * 解析不同格式的文档，返回文本和图片资源
 *
 * 返回的 ParsedDocument 包含：
 * - text: 纯文本内容（含 Markdown 标记，供切分器使用）
 * - images: 图片资源数组（无图片的文档为空数组）
 *
 * 各解析器路径：
 * - PDF: MinerU 主路径（提取图片） / pdfjs 降级路径（不提取图片）
 * - Word/Excel/文本: 当前不提取图片，images 为空数组（后续 Slice 引入）
 *
 * @param filePath 文件的绝对路径
 * @param mimeType 文件的 MIME 类型
 * @returns 解析结果
 */
export async function parseDocument(
  filePath: string,
  mimeType: string,
): Promise<ParsedDocument> {
  // 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  // 根据文件类型选择解析方法
  switch (mimeType) {
    case 'text/plain':
    case 'text/markdown':
    case 'text/csv':
    case 'application/json':
    case 'text/html':
    case 'text/xml':
      return await parseTextFile(filePath);

    case 'application/pdf':
      return await parsePdfFile(filePath);

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/msword':
      return await parseWordFile(filePath);

    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.ms-excel':
      return await parseExcelFile(filePath);

    default:
      // 对于 application/octet-stream 等未知 MIME 类型，按扩展名回退解析
      const ext = path.extname(filePath).toLowerCase();
      const textExts = [
        '.txt',
        '.md',
        '.csv',
        '.json',
        '.html',
        '.htm',
        '.xml',
        '.log',
        '.yaml',
        '.yml',
        '.toml',
        '.ini',
        '.cfg',
        '.conf',
      ];
      if (textExts.includes(ext)) {
        return await parseTextFile(filePath);
      }
      throw new Error(`不支持的文件类型: ${mimeType}（扩展名: ${ext}）`);
  }
}

/**
 * 解析纯文本文件
 * 纯文本无图片资源，images 固定为空数组
 */
async function parseTextFile(filePath: string): Promise<ParsedDocument> {
  const text = await new Promise<string>((resolve, reject) => {
    fs.readFile(filePath, 'utf-8', (err, data) => {
      if (err) {
        reject(new Error(`读取文本文件失败: ${err.message}`));
        return;
      }
      resolve(data);
    });
  });
  return { text, images: [] };
}

/**
 * 解析 PDF 文件
 * 优先使用 MinerU API（支持图片/代码块/表格/公式），失败降级到 pdfjs-dist
 *
 * 降级触发条件：
 * - MinerU 未启用或未配置 Token -> 直接降级
 * - MinerU 调用抛出任何异常（网络错误、超时、配额超限、解析失败等）-> 降级
 * - MinerU 返回空 markdown -> 抛错后降级
 *
 * 图片提取：
 * - MinerU 路径：从 result.images 提取，构造 ImageAsset 数组
 * - pdfjs 降级路径：不提取图片（Slice 4 会引入页面渲染方案）
 */
async function parsePdfFile(filePath: string): Promise<ParsedDocument> {
  // 检查 MinerU 是否可用
  if (isMineruAvailable()) {
    try {
      logger.info('使用 MinerU API 解析 PDF', {
        module: 'DocumentParser',
        filePath: path.basename(filePath),
      });
      return await parsePdfWithMineru(filePath);
    } catch (err: unknown) {
      // MinerU 失败的常见原因：网络错误、超时、Token 失效、配额超限、文件格式不支持
      // 无论什么原因，都降级到本地 pdfjs-dist，保证 PDF 解析可用
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack : undefined;
      logger.warn('MinerU 解析失败，降级到 pdfjs-dist', {
        module: 'DocumentParser',
        error: errMsg,
        stack: errStack,
        filePath: path.basename(filePath),
      });
    }
  }

  // 降级：使用本地 pdfjs-dist 解析
  return await parsePdfWithPdfjs(filePath);
}

/**
 * 检查 MinerU 是否可用（开关已开启 + Token 已配置）
 * 注意：文件上传方式不需要公网 URL，本地文件直接上传给 MinerU
 *
 * 配置来源：运行时配置（前端设置面板）优先，.env 兜底——
 * 用户在前端填 Token/切开关后立即生效，无需改 .env + 重建容器
 */
function isMineruAvailable(): boolean {
  const mineruCfg = getMineruEffectiveConfig();
  if (!mineruCfg.enabled) return false;
  if (!mineruCfg.apiToken) return false;
  return true;
}

/**
 * 使用 MinerU 在线 API 解析 PDF（通过官方 SDK，文件上传方式，无需内网穿透）
 *
 * SDK 内部自动完成：申请上传链接 → 上传文件 → 轮询任务 → 下载 ZIP → 解压提取 Markdown
 */
async function parsePdfWithMineru(filePath: string): Promise<ParsedDocument> {
  const { MinerU } = await import('mineru-open-sdk');
  const fileName = path.basename(filePath);

  // Token / 模型版本走运行时配置（.env 兜底）；超时暂不支持前端调整，保持 .env
  const mineruCfg = getMineruEffectiveConfig();

  // SDK 超时参数是秒，配置里是毫秒
  const timeoutSec = Math.floor(config.mineru.timeoutMs / 1000);

  const client = new MinerU(mineruCfg.apiToken);

  logger.info('使用 MinerU SDK 解析 PDF', {
    module: 'DocumentParser',
    fileName,
    model: mineruCfg.modelVersion,
    timeoutSec,
  });

  const result = await client.extract(filePath, {
    model: mineruCfg.modelVersion,
    timeout: timeoutSec,
  });

  if (!result.markdown) {
    throw new Error(
      `MinerU 解析完成但未返回 Markdown 内容（taskId: ${result.taskId}, state: ${result.state}）`,
    );
  }

  // 从 MinerU 结果中提取图片资源（含图注、章节、前后文等上下文信息）
  const images = extractImagesFromMineru(result.markdown, result.images);

  // 替换 MinerU markdown 中的图片引用为占位符
  // 原因：MinerU 返回的 ![](images/xxx.jpg) 是内部相对路径，前端无法访问，
  // 且 LLM 看到后会原样复制到回复中导致图片裂图。图片详情已通过独立的图片描述块提供。
  let text = replaceMineruImageRefs(result.markdown);

  // 公式解释：MinerU 已将公式转为 LaTeX，启用后追加自然语言描述
  // 失败不阻塞主流程，仅影响公式检索质量
  // S3-1 修复：传入 text（已替换图片引用）而非 result.markdown，避免公式解释覆盖图片替换结果
  if (config.formula.enabled) {
    try {
      const formulaResult = await explainFormulas(text, fileName);
      text = formulaResult.text;
      logger.info('公式解释完成', {
        module: 'DocumentParser',
        taskId: result.taskId,
        fileName,
        totalFormulas: formulaResult.totalFormulas,
        explainedCount: formulaResult.explainedCount,
        skippedCount: formulaResult.skippedCount,
        failedCount: formulaResult.failedCount,
      });
    } catch (err: any) {
      logger.warn('公式解释失败，保留原始 markdown', {
        module: 'DocumentParser',
        taskId: result.taskId,
        fileName,
        error: err.message,
      });
    }
  }

  logger.info('MinerU 解析成功', {
    module: 'DocumentParser',
    taskId: result.taskId,
    fileName,
    markdownLength: result.markdown.length,
    finalTextLength: text.length,
    imagesCount: result.images.length,
    extractedImagesCount: images.length,
    imagesWithCaption: images.filter((img) => img.caption !== null).length,
  });

  return {
    text,
    images,
  };
}

/**
 * 使用本地 pdfjs-dist 解析 PDF（降级方案）
 *
 * 流程：
 * 1. 提取每页纯文本（基于 Y 坐标重建换行结构）
 * 2. 如果扫描件检测开启：检测扫描件页面（字符数低于阈值）
 * 3. 如果检测到扫描件页面：从这些页面提取嵌入图片（通过 getOperatorList）
 *    - 扫描件页面通常是整页图片，提取后走 VLM 翻译
 *    - 非扫描件页面不提取图片（MinerU 路径才处理嵌入图表）
 *
 * 注意：pdfjs 降级路径不提取非扫描件页面的嵌入图片，原因：
 * - getOperatorList 遍历所有页面开销大
 * - MinerU 路径已覆盖嵌入图片提取
 * - 降级路径优先保证文本可用，图片是增强项
 */
async function parsePdfWithPdfjs(filePath: string): Promise<ParsedDocument> {
  const pdfjs = await getPdfjs();

  const dataBuffer = fs.readFileSync(filePath);
  const data = new Uint8Array(dataBuffer);

  const loadingTask = pdfjs.getDocument({
    data,
    cMapUrl: PDFJS_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_STANDARD_FONT_URL,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableWorker: true, // Node.js 下 worker 线程缺浏览器 API，强制主线程运行
  } as Record<string, unknown>);

  try {
    const pdfDocument = await loadingTask.promise;
    const pageTexts: string[] = [];

    for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
      const page = await pdfDocument.getPage(pageNum);
      const textContent = await page.getTextContent();

      // 基于 Y 坐标重建文本，保留换行结构
      let lastY: number | null = null;
      let lastItem: { maxX: number } | null = null;
      let pageText = '';

      for (const item of textContent.items) {
        if (!('str' in item)) continue;
        const ti = item as {
          str: string;
          transform: number[];
          width: number;
          height: number;
          hasEOL?: boolean;
        };

        if (ti.str === '') continue;

        const y = ti.transform[5];
        const x = ti.transform[4];

        // Y 坐标变化超过行高一半 → 换行
        if (
          lastY !== null &&
          Math.abs(y - lastY) > Math.max(ti.height * 0.5, 2)
        ) {
          if (!pageText.endsWith('\n')) {
            pageText += '\n';
          }
        } else if (lastItem !== null && lastY === y) {
          // 同一行，检查 X 间距判断是否需要空格
          const gap = x - lastItem.maxX;
          if (gap > 1 && !pageText.endsWith(' ') && !pageText.endsWith('\n')) {
            pageText += ' ';
          }
        }

        pageText += ti.str;
        lastY = y;
        lastItem = { maxX: x + ti.width };

        if (ti.hasEOL) {
          if (!pageText.endsWith('\n')) {
            pageText += '\n';
          }
          lastY = null;
          lastItem = null;
        }
      }

      pageTexts.push(pageText.trim());
      await page.cleanup();
    }

    const text = pageTexts.join('\n\n');

    // 扫描件检测 + 图片提取
    let images: import('./image-extractor/index.js').ImageAsset[] = [];
    if (isScannedPdfDetectionEnabled()) {
      try {
        const detectionResult = await detectScannedPages(
          pdfDocument as unknown as PdfDocumentLike,
        );

        if (detectionResult.scannedPageNumbers.length > 0) {
          logger.info('检测到扫描件页面，开始提取图片', {
            module: 'DocumentParser',
            fileName: path.basename(filePath),
            scannedPages: detectionResult.scannedPageNumbers,
            totalPages: detectionResult.totalPages,
          });

          images = await extractImagesFromPdfjs(
            pdfDocument as unknown as PdfDocumentLike,
            detectionResult.scannedPageNumbers,
            detectionResult.scannedPageNumbers,
          );

          logger.info('扫描件图片提取完成', {
            module: 'DocumentParser',
            fileName: path.basename(filePath),
            extractedImages: images.length,
          });
        }
      } catch (err: any) {
        logger.warn('扫描件检测/图片提取失败，仅返回文本', {
          module: 'DocumentParser',
          fileName: path.basename(filePath),
          error: err.message,
        });
      }
    }

    await loadingTask.destroy();
    return { text, images };
  } catch (err: unknown) {
    try {
      await loadingTask.destroy();
    } catch {
      /* ignore */
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`解析 PDF 文件失败: ${errMsg}`);
  }
}

/**
 * 解析 Word 文件 (.docx)
 *
 * 使用 mammoth.convertToHtml 将 docx 转为 HTML，然后用 cheerio：
 * 1. 提取 <img> 标签中的 base64 图片（含图注、章节、前后文）
 * 2. 从 HTML 提取纯文本（保留段落结构）
 *
 * 比 extractRawText 多了图片提取能力，文本质量也更好（保留段落结构）。
 */
async function parseWordFile(filePath: string): Promise<ParsedDocument> {
  try {
    const { text, images } = await extractFromWord(filePath);
    return { text, images };
  } catch (err: any) {
    // convertToHtml 失败时降级到 extractRawText（至少保证文本可用）
    logger.warn('convertToHtml 解析失败，降级到 extractRawText', {
      module: 'DocumentParser',
      fileName: path.basename(filePath),
      error: err.message,
    });

    try {
      const result = await mammoth.extractRawText({ path: filePath });
      return { text: result.value, images: [] };
    } catch (fallbackErr: any) {
      throw new Error(`解析 Word 文件失败: ${fallbackErr.message}`);
    }
  }
}

/**
 * 解析 Excel 文件 (.xlsx)
 * 将每个 sheet 转换为 "Sheet: sheetName\n" + CSV-like 文本，多 sheet 之间用空行分隔
 *
 * 暂不提取嵌入图片（xl/media/ 下的图片），仅返回纯文本。后续如需图片提取，
 * 可在 image-extractor/ 下新增 excel.ts 解压 xlsx 读取 xl/media/。
 */
async function parseExcelFile(filePath: string): Promise<ParsedDocument> {
  try {
    const workbook = XLSX.readFile(filePath);
    const sheets: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      // 上传时结构识别（保守启发式落成声明指令，声明优于推断）：
      // HeaderRow 锚定报表式表头（说明行不进数据）、TotalRow 锚定汇总行
      // （聚合结果行不参与填充/规则/条件）——后端解析器与前端网格据此对齐
      sheets.push(buildSheetBlockText(sheetName, csv));
    }
    return {
      text: sheets.join('\n\n'),
      images: [],
      // 标记来源为 Excel：前端编辑器据此把 sheet 结构化文本转为网格表格；
      // 聊天/检索链路只消费 text 字段，不受该标记影响
      sourceFormat: 'xlsx',
      sheetNames: [...workbook.SheetNames],
    };
  } catch (err: any) {
    throw new Error(`解析 Excel 文件失败: ${err.message}`);
  }
}

// ==================== sheet 结构化文本 → xlsx 导出 ====================

/**
 * 单行 CSV 解析（RFC 4180 子集：支持引号包裹与 "" 转义）。
 * 与前端 table-convert.ts 的 parseCsvLine 逻辑保持一致——
 * 两侧都只处理"本项目生成的 CSV"（sheet_to_csv / 前端 escapeCsvCell 产物），
 * 多行引号单元格这类极端输入是已接受的 M1 边界。
 * 导出供 table-ops 执行器复用（AI 表格指令在文本层读写同一格式）。
 */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

/** sheet 标题行格式（与 parseExcelFile 产物、前端 table-convert.ts 三方对齐） */
export const SHEET_HEADING_RE = /^#{0,4}\s*Sheet\s*[:：]\s*(.+)$/;

/**
 * 表头行指令（报表式表格锚点）：出现在 `Sheet: 名称` 行之后的第一个非空行，
 * 值 N = 表头所在的内容行号（1 起，按含说明行的完整行序数）。
 * 指令之后的第 1..N-1 个非空行是说明行（标题/日期范围等，不当数据），
 * 第 N 个非空行是表头，其后是数据行。缺省 = 1（首行为表头，旧格式完全兼容）。
 * 与前端 table-convert.ts 的同名正则保持一致（三方对齐，勿单侧修改）。
 */
export const HEADER_ROW_RE = /^HeaderRow\s*[:：]\s*(\d+)$/i;

/**
 * 汇总行指令（聚合结果行锚点）：出现在 `Sheet: 名称` 行之后、与 HeaderRow
 * 同处的块首结构指令区，值 = 汇总行内容行号列表（逗号分隔，1 起按含说明行
 * 的完整行序数，与 HeaderRow 同口径），支持分组小计多个行号。
 * 汇总行不是明细数据：语义填充/规则校验/条件匹配/派生列自动跳过。
 * 与前端 table-convert.ts 的同名正则保持一致（三方对齐，勿单侧修改）。
 */
export const TOTAL_ROW_RE = /^TotalRow\s*[:：]\s*(\d+(?:\s*[,，]\s*\d+)*)$/i;

/**
 * 跨表关联填充溯源指令（三方对齐勿单侧改：executor.parseSheetData /
 * sheetTextToXlsx / 前端 table-convert）：
 * `LookupFill: 目标列|目标键列|源表|源键列|源值列`——记录某列最近一次由哪张表
 * 按哪个键关联填充。与 HeaderRow/TotalRow 同在块首结构指令区（顺序不限、可多条）。
 * 导出 xlsx 时（withFormulas 开启）据此把目标列数据格改写为 INDEX/MATCH 公式；
 * 目标列被其他操作改写时声明自动失效（executor invalidateLookupFills）。
 * 单元格值含竖线会破坏分隔——写入侧过滤含竖线的部分（宁可不声明，不可声明错）。
 */
export const LOOKUP_FILL_RE = /^LookupFill\s*[:：]\s*(.+)$/i;

/**
 * 汇总行标签正则（行首单元格整格匹配）：总计/合计/小计/汇总（可带冒号）。
 * 仅用于上传时的保守自动检测；运行期一律以声明的 TotalRow 指令 /
 * setTotalRows 操作为准（声明优于推断，与 HeaderRow 同架构）。
 */
export const TOTAL_LABEL_RE = /^(?:总计|合计|小计|汇总)[:：]?$/;

/** 该行首格是否命中汇总行标签（检测用；消费方请用声明的汇总行标记） */
export function isTotalLabelRow(cells: string[]): boolean {
  const first = cells.find((c) => c.trim() !== '');
  return first !== undefined && TOTAL_LABEL_RE.test(first.trim());
}

/**
 * 汇总行保守自动识别（上传时启发式，宁可漏判不可误判）：
 * 数据区中首格恰为 总计/合计/小计/汇总 单词（可带冒号）的行判为汇总行。
 * 标签必须整格精确命中（"合计（含税）"这类不触发），误判可由
 * setTotalRows 操作纠正；未命中的非标准标签可手动声明。
 *
 * @param csv              sheet 的 CSV 文本
 * @param headerRowContent 表头内容行号（detectReportHeaderRow 的产出；null 按 1）
 * @returns 汇总行内容行号列表（升序）；无则空数组
 */
export function detectTotalRowIndexes(csv: string, headerRowContent: number | null): number[] {
  const headerIdx = headerRowContent ?? 1;
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const results: number[] = [];
  for (let i = headerIdx; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const first = cells.find((c) => c.trim() !== '');
    if (first !== undefined && TOTAL_LABEL_RE.test(first.trim())) {
      results.push(i + 1);
    }
  }
  return results;
}

/**
 * 由 sheet 名 + CSV 组装"sheet 结构化文本"块（parseExcelFile 的产出单元）。
 * 上传时在此完成两项保守结构识别并落成指令（声明优于推断，运行期一律
 * 以指令声明的结构为准）：报表式表头锚定（HeaderRow）+ 汇总行锚定（TotalRow）。
 */
export function buildSheetBlockText(sheetName: string, csv: string): string {
  const headerRow = detectReportHeaderRow(csv);
  const totalRows = detectTotalRowIndexes(csv, headerRow);
  const directiveLines: string[] = [];
  if (headerRow !== null) directiveLines.push(`HeaderRow: ${headerRow}`);
  if (totalRows.length > 0) directiveLines.push(`TotalRow: ${totalRows.join(',')}`);
  const directiveText = directiveLines.length > 0 ? `${directiveLines.join('\n')}\n` : '';
  return `Sheet: ${sheetName}\n${directiveText}${csv}`;
}

/**
 * 说明行格子判定（键值对特征）：格子形如 "制表人:张三" / "日期：2026-10-01"
 * （短键 + 全/半角冒号）即视为说明性内容——报表顶部的制表人/审核人/单位等
 * 落款行即使占多个格子也不是表头。键必须含非数字字符：时间值 "10:30"/"9:00"
 * 的键是纯数字，不算键值对（否则无表头排班表的首行时间数据会被误跳过，
 * 导致下一行数据被误锚定为表头）。
 */
function isKeyValueCell(cell: string): boolean {
  // (?![\d]{1,20}[:：])：键全为数字（如 "10:"）不算键值对
  return /^(?![\d]{1,20}[:：])[^:：]{1,20}[:：]\S/.test(cell.trim());
}

/**
 * 表头特征校验（防把数据行误判成表头）：真表头的格子几乎都是
 * 短文本、不含纯数字、列名互不重复。候选行任一特征不满足 → 放弃猜测
 * （宁可漏判维持默认，不可安错表头）。
 */
function looksLikeHeaderRow(cells: string[]): boolean {
  const trimmed = cells.map((c) => c.trim());
  // 表头不会是纯数字（"序号"可以，"1"不行）
  if (trimmed.some((c) => /^-?\d+(?:[.,]\d+)?$/.test(c))) return false;
  // 列名都是短文本
  if (trimmed.some((c) => c.length > 30)) return false;
  // 列名不重复
  if (new Set(trimmed).size !== trimmed.length) return false;
  return true;
}

/**
 * 报表式表头保守自动识别（上传时启发式，宁可漏判不可误判）：
 * 从上往下找首个"非说明行"：说明行 = 单非空格行（大标题/日期等合并单元格
 * 特征）或全键值对行（"制表人:张三,审核人:李四"落款特征）；候选行还需通过
 * 表头特征校验（短文本/无纯数字/不重复）。支持任意行数的连续说明行
 * （如"销售汇总报告 / 2026-10-01~11 / 产品类别,金额小计"→ 表头在第 3 行）。
 * 无表头候选或候选不像表头 → 返回 null（不产生指令行，维持默认）。
 * 说明：SheetJS 产出的 CSV 中含逗号的单元格必然带引号包裹，因此单列表
 * 不会被误判出"≥2 非空格"的行。
 *
 * @returns 表头行号（1 起）；无法识别返回 null（不产生指令行，维持默认）
 */
export function detectReportHeaderRow(csv: string): number | null {
  const rows = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(parseCsvLine);
  if (rows.length < 3) return null;
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].filter((c) => c.trim().length > 0);
    if (cells.length === 0) continue;
    if (cells.length === 1) continue; // 单格说明行
    if (cells.every(isKeyValueCell)) continue; // 键值对落款行
    // 首个非说明行 = 表头候选；特征不符 → 放弃（不继续向下找，防把数据行当表头）
    if (!looksLikeHeaderRow(cells)) return null;
    // i=0 即第 1 行就是表头（常规表，不产生指令）；否则锚定 i+1（上方全是说明行）
    return i === 0 ? null : i + 1;
  }
  return null;
}

/** Excel sheet 名的非法字符（Excel 规范禁止 : \ / ? * [ ]） */
const SHEET_NAME_INVALID_CHARS = /[:\\/?*[\]]/g;

/** Excel sheet 名最大长度（Excel 规范 31 字符；留 3 位给去重后缀 "(9)"） */
const SHEET_NAME_MAX_LENGTH = 28;

/**
 * 清洗 sheet 名称：替换非法字符、截断、去空，保证是合法且不重复的 Excel sheet 名
 */
function dedupeSheetName(rawName: string, used: Set<string>): string {
  let base = rawName.replace(SHEET_NAME_INVALID_CHARS, '_').trim() || 'Sheet1';
  if (base.length > SHEET_NAME_MAX_LENGTH) base = base.slice(0, SHEET_NAME_MAX_LENGTH);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}(${i})`)) i++;
  const name = `${base}(${i})`;
  used.add(name);
  return name;
}

/**
 * 把"sheet 结构化文本"还原为 xlsx 二进制（编辑器 Excel 导出用）。
 *
 * 输入格式与 parseExcelFile 的产物一致：`Sheet: 名称` 行 + CSV 行，sheet 间空行分隔。
 * 编辑器保存产生的版本（contentText 落盘为 txt 版本文件）与原始 xlsx 版本
 * 经 parseVersionText 后都是该格式，因此导出统一走本函数，无需区分版本种类。
 *
 * 容错（宁肯多保数据，不可导出报错）：
 *   - 标题前的散行归入 "Sheet1"；普通文本行按单列数据保留（数据不丢）；
 *   - 空行是 sheet 分隔符，跳过；
 *   - sheet 名非法/重复自动清洗去重；
 *   - 无任何数据行时返回 null，调用方给业务错误提示。
 *
 * @param text sheet 结构化文本
 * @param options.withFormulas 为 true 时把块首 LookupFill 声明改写为 INDEX/MATCH
 *   真实公式（只写空格、不覆盖已有值，与 executor.lookupFill 同语义）；声明引用的
 *   源表/列不可定位时跳过该声明（宁缺勿错）。缺省 false 保持纯值导出
 * @returns xlsx 文件 Buffer；无表格数据时返回 null
 */
export function sheetTextToXlsx(
  text: string,
  options?: { withFormulas?: boolean },
): Buffer | null {
  interface LookupFillDirective {
    targetColumn: string;
    targetKeyColumn: string;
    sourceSheet: string;
    sourceKeyColumn: string;
    sourceValueColumn: string;
  }
  interface OutSheet {
    name: string;
    rows: string[][];
    /** 块首指令区捕获的 TotalRow 内容行号（1 起含说明行；rows[n-1] 即内容行 n）。
     *  指令本身不写进 Excel，但公式导出需要它跳过汇总行（与 executor.lookupFill 同语义） */
    totalLines: number[];
    /** 块首指令区捕获的 LookupFill 声明（withFormulas 时改写为 INDEX/MATCH 公式） */
    lookupFills: LookupFillDirective[];
  }
  const sheets: OutSheet[] = [];
  let current: OutSheet | null = null;
  // 当前 sheet 块是否仍处于块首结构指令区（与 parseSheetData 口径一致：
  // HeaderRow / TotalRow / LookupFill 指令是元数据不是数据，跳过不写进 Excel，
  // 否则导出产物混入指令行，再上传还会造成二次错位）
  let directiveZone = true;

  for (const rawLine of text.split(/\r?\n/)) {
    const m = rawLine.trim().match(SHEET_HEADING_RE);
    if (m) {
      current = { name: m[1].trim(), rows: [], totalLines: [], lookupFills: [] };
      directiveZone = true;
      sheets.push(current);
      continue;
    }
    if (!rawLine.trim()) continue;
    // 标题前的散行（无所属 sheet）归入默认 sheet
    if (!current) {
      current = { name: 'Sheet1', rows: [], totalLines: [], lookupFills: [] };
      directiveZone = true;
      sheets.push(current);
    }
    if (directiveZone) {
      const trimmed = rawLine.trim();
      const tr = trimmed.match(TOTAL_ROW_RE);
      if (tr && current) {
        // 汇总行号只用于公式导出时跳行：段数/范围容错（非法段丢弃，宁缺勿错）
        for (const seg of tr[1].split(/[,，]/)) {
          const n = Number(seg.trim());
          if (Number.isInteger(n) && n >= 1) current.totalLines.push(n);
        }
        continue;
      }
      if (HEADER_ROW_RE.test(trimmed)) continue;
      const lf = trimmed.match(LOOKUP_FILL_RE);
      if (lf) {
        // 与 executor.parseSheetData 同口径：5 段齐全且非空才收，脏标记丢弃（宁可不声明不可声明错）
        const parts = lf[1].split('|').map((p) => p.trim());
        if (parts.length === 5 && parts.every((p) => p.length > 0) && current) {
          current.lookupFills.push({
            targetColumn: parts[0],
            targetKeyColumn: parts[1],
            sourceSheet: parts[2],
            sourceKeyColumn: parts[3],
            sourceValueColumn: parts[4],
          });
        }
        continue;
      }
      directiveZone = false; // 第一个非指令行：结构区结束
    }
    current.rows.push(parseCsvLine(rawLine));
  }

  const validSheets = sheets.filter((s) => s.rows.length > 0);
  if (validSheets.length === 0) return null;

  const usedNames = new Set<string>();
  const workbook = XLSX.utils.book_new();
  for (const sheet of validSheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    // withFormulas（opt-in）：把 LookupFill 声明改写为真实 Excel 公式——
    // 用户在 Excel 中可验证、可续算，公式与数据不分离（决策 4：本期做公式导出）
    if (options?.withFormulas && sheet.lookupFills.length > 0) {
      const header = sheet.rows[0] ?? [];
      for (const d of sheet.lookupFills) {
        const targetColIdx = header.indexOf(d.targetColumn);
        const targetKeyIdx = header.indexOf(d.targetKeyColumn);
        // 源表必须在同一工作簿中且列可定位；任一条件不满足就跳过该声明（宁缺勿错）
        const src =
          d.sourceSheet === sheet.name
            ? sheet
            : validSheets.find((s) => s.name === d.sourceSheet);
        if (!src || targetColIdx < 0 || targetKeyIdx < 0) continue;
        const srcHeader = src.rows[0] ?? [];
        const srcKeyIdx = srcHeader.indexOf(d.sourceKeyColumn);
        const srcValIdx = srcHeader.indexOf(d.sourceValueColumn);
        if (srcKeyIdx < 0 || srcValIdx < 0) continue;

        // Excel 引用（1-based，含表头行）：数据区 = 第 2 行 ~ 第 rows.length 行
        const srcRef = `'${src.name.replace(/'/g, "''")}'`;
        const valueRange = `${srcRef}!$${XLSX.utils.encode_col(srcValIdx)}$2:$${XLSX.utils.encode_col(srcValIdx)}$${src.rows.length}`;
        const keyRange = `${srcRef}!$${XLSX.utils.encode_col(srcKeyIdx)}$2:$${XLSX.utils.encode_col(srcKeyIdx)}$${src.rows.length}`;
        const keyCol = XLSX.utils.encode_col(targetKeyIdx);
        let written = 0;
        for (let r = 1; r < sheet.rows.length; r++) {
          // 与 executor.lookupFill 同语义：目标表已声明汇总行不填公式
          //（TotalRow 指令导出时已消费、行留在数据区；内容行 n ↔ rows[n-1]）
          if (sheet.totalLines.includes(r + 1)) continue;
          const row = sheet.rows[r] ?? [];
          const targetCell = row[targetColIdx];
          const keyCell = row[targetKeyIdx];
          // 与 executor.lookupFill 同语义：只给空格写公式（不覆盖已有值），键为空的行跳过
          if (targetCell && targetCell.trim()) continue;
          const keyVal = (keyCell ?? '').trim();
          if (!keyVal) continue;
          // 首个命中行（与 executor 关联语义一致）；未命中留空——不写必然 #N/A 的公式
          const hitRow = src.rows
            .slice(1)
            .find((r2) => ((r2[srcKeyIdx] ?? '') as string).trim() === keyVal);
          if (!hitRow) continue;
          const rawVal = ((hitRow[srcValIdx] ?? '') as string).trim();
          if (!rawVal) continue;
          // 缓存值必须随公式一起写：SheetJS 会丢弃无 v 的公式单元格（round-trip 丢失），
          // 且不重算公式的预览工具也能直接读到值；Excel 打开后可重算验证
          const addr = XLSX.utils.encode_cell({ r, c: targetColIdx });
          const formula = `INDEX(${valueRange},MATCH(${keyCol}${r + 1},${keyRange},0))`;
          const num = Number(rawVal.replace(/,/g, ''));
          ws[addr] =
            Number.isFinite(num)
              ? { t: 'n', v: num, f: formula }
              : { t: 's', v: rawVal, f: formula };
          written++;
        }
        if (written > 0) {
          logger.info('导出 xlsx 写入 INDEX/MATCH 公式', {
            module: 'DocumentParser',
            sheet: sheet.name,
            targetColumn: d.targetColumn,
            formulaCount: written,
          });
        }
      }
    }
    XLSX.utils.book_append_sheet(workbook, ws, dedupeSheetName(sheet.name, usedNames));
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/**
 * 替换 MinerU markdown 中的图片引用为占位符
 *
 * MinerU 返回的 markdown 中图片以 `![](images/xxx.jpg)` 形式引用，
 * 这些路径是 MinerU 内部相对路径，前端无法访问。若保留在文本中：
 * 1. LLM 看到后会原样复制到回复中，导致前端渲染裂图
 * 2. 占用 token 且无实际价值
 *
 * 替换为 `[图片 N]` 占位符，图片详情通过独立的图片描述块（VLM 生成）提供。
 * 只替换相对路径引用，不影响合法的网络图片 URL（http/https 开头）。
 *
 * @param markdown MinerU 返回的原始 markdown
 * @returns 替换后的 markdown（图片引用变为 [图片 N] 占位符）
 */
function replaceMineruImageRefs(markdown: string): string {
  let imgIdx = 0;
  // 匹配 ![alt](path) 格式，排除 http:// 和 https:// 开头的完整 URL
  // MinerU 图片引用都是相对路径（如 images/abc.jpg 或 abc.jpg）
  return markdown.replace(
    /!\[[^\]]*\]\((?!https?:\/\/)([^)]+)\)/g,
    () => `[图片 ${++imgIdx}]`,
  );
}

/**
 * 根据文件扩展名获取 MIME 类型
 */
export function getMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();

  const mimeTypes: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx':
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx':
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.json': 'application/json',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.xml': 'text/xml',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}
