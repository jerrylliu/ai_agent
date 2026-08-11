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
const PDFJS_BUILD_PATH = path.dirname(
  require.resolve('pdfjs-dist/build/pdf.mjs'),
);
const PDFJS_ROOT_PATH = path.dirname(PDFJS_BUILD_PATH);
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

  pdfjsLib = await import('pdfjs-dist');
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
 */
function isMineruAvailable(): boolean {
  if (!config.mineru.enabled) return false;
  if (!config.mineru.apiToken) return false;
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

  // SDK 超时参数是秒，配置里是毫秒
  const timeoutSec = Math.floor(config.mineru.timeoutMs / 1000);

  const client = new MinerU(config.mineru.apiToken);

  logger.info('使用 MinerU SDK 解析 PDF', {
    module: 'DocumentParser',
    fileName,
    model: config.mineru.modelVersion,
    timeoutSec,
  });

  const result = await client.extract(filePath, {
    model: config.mineru.modelVersion,
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
      const formulaResult = await explainFormulas(
        text,
        fileName,
      );
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
      sheets.push(`Sheet: ${sheetName}\n${csv}`);
    }
    return { text: sheets.join('\n\n'), images: [] };
  } catch (err: any) {
    throw new Error(`解析 Excel 文件失败: ${err.message}`);
  }
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
