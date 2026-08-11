/**
 * pdfjs 降级路径图片提取器
 *
 * 职责：
 * 1. 从 pdfjs 加载的 PDF 中提取嵌入的栅格图片（通过 getOperatorList）
 * 2. 将原始 RGB/RGBA 像素数据编码为 PNG buffer（内置 zlib 编码器，无外部依赖）
 * 3. 为扫描件页面提取全页图片（整页通常是一张嵌入图片）
 *
 * 不依赖 canvas / @napi-rs/canvas / sharp 等图像库：
 * - pdfjs 的 page.objs 返回原始 RGB/RGBA 像素数据
 * - 本模块用 Node.js 内置 zlib 实现 PNG 编码（约 60 行代码）
 * - 避免引入需要系统依赖的 node-canvas 或需要单独安装的 @napi-rs/canvas
 *
 * 调用方：document-parser.ts 的 parsePdfWithPdfjs
 */

import * as zlib from 'zlib';
import type { ImageAsset } from './index.js';
import type { PdfDocumentLike } from '../scanned-pdf-detector.js';
import { logger } from '../logger.js';

/**
 * 扩展 PdfPageLike 接口，增加图片提取需要的方法
 *
 * scanned-pdf-detector 的 PdfPageLike 只声明了 getTextContent，
 * 图片提取还需要 getOperatorList 和 objs。
 */
interface PdfPageWithOps {
  getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
  getOperatorList(): Promise<unknown>;
  objs?: {
    get: (name: string, callback?: (obj: unknown) => void) => unknown;
  };
  cleanup(): Promise<void>;
}

/** pdfjs OPS 常量的最小声明 */
interface PdfjsOps {
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintImageMaskXObject: number;
}

/** pdfjs 页面操作符列表 */
interface OperatorList {
  fnArray: number[];
  argsArray: unknown[][];
}

/** pdfjs 图片对象的结构 */
interface PdfImageObject {
  width: number;
  height: number;
  kind: number;
  data: Uint8ClampedArray;
}

/** pdfjs ImageKind 常量 */
const IMAGE_KIND_GRAY_1BPP = 1;
const IMAGE_KIND_RGB_24BPP = 2;
const IMAGE_KIND_RGBA_32BPP = 3;

/**
 * 从 pdfjs PDF 文档中提取图片
 *
 * 提取策略：
 * 1. 遍历扫描件页面（或全部页面）
 * 2. 对每页获取操作符列表，找到 paintImageXObject 操作
 * 3. 从页面对象库获取图片像素数据
 * 4. 编码为 PNG buffer，构造 ImageAsset
 *
 * @param pdfDocument pdfjs 加载的 PDF 文档
 * @param pageNumbers 要提取图片的页码列表（1-based）。如果为空则不提取。
 * @param scannedPageNumbers 扫描件页码列表（用于标记 sourceType）
 * @returns ImageAsset 数组
 */
export async function extractImagesFromPdfjs(
  pdfDocument: PdfDocumentLike,
  pageNumbers: number[],
  scannedPageNumbers: number[],
): Promise<ImageAsset[]> {
  if (pageNumbers.length === 0) return [];

  // 获取 pdfjs OPS 常量（通过运行时获取，避免直接 import pdfjs 类型）
  const ops = await getPdfjsOps(pdfDocument);
  if (!ops) {
    logger.warn('无法获取 pdfjs OPS 常量，跳过图片提取', {
      module: 'PdfjsImageExtractor',
    });
    return [];
  }

  const scannedSet = new Set(scannedPageNumbers);
  const images: ImageAsset[] = [];
  let sourceIndex = 0;

  for (const pageNum of pageNumbers) {
    const page = await pdfDocument.getPage(pageNum);
    const pageWithOps = page as unknown as PdfPageWithOps;
    try {
      const opList = (await pageWithOps.getOperatorList()) as unknown as OperatorList;
      const pageImages = await extractImagesFromPage(
        pageWithOps,
        opList,
        ops,
        pageNum,
        scannedSet.has(pageNum),
      );

      for (const img of pageImages) {
        images.push({
          buffer: img.pngBuffer,
          sourceIndex: sourceIndex++,
          caption: null,
          page: pageNum,
          section: null,
          surroundingText: img.isFullPage
            ? `扫描件页面（第${pageNum}页），整页渲染为图片`
            : `嵌入图片（第${pageNum}页）`,
          originalPath: `pdfjs_page_${pageNum}_img_${sourceIndex - 1}.png`,
          sourceType: scannedSet.has(pageNum) ? 'scanned_page' : 'embedded',
        });
      }
    } finally {
      await page.cleanup();
    }
  }

  logger.info('pdfjs 图片提取完成', {
    module: 'PdfjsImageExtractor',
    totalPages: pageNumbers.length,
    extractedImages: images.length,
    scannedPages: scannedPageNumbers.length,
  });

  return images;
}

/**
 * 从单个页面提取嵌入图片
 */
async function extractImagesFromPage(
  page: PdfPageWithOps,
  opList: OperatorList,
  ops: PdfjsOps,
  pageNum: number,
  isScannedPage: boolean,
): Promise<Array<{ pngBuffer: Buffer; isFullPage: boolean }>> {
  const results: Array<{ pngBuffer: Buffer; isFullPage: boolean }> = [];

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const isImageOp =
      fn === ops.paintImageXObject ||
      fn === ops.paintInlineImageXObject ||
      fn === ops.paintImageMaskXObject;

    if (!isImageOp) continue;

    const args = opList.argsArray[i];
    if (!args || args.length === 0) continue;

    try {
      const imgObj = await resolveImageObject(page, args, fn === ops.paintInlineImageXObject);
      if (!imgObj || !isValidImageObject(imgObj)) continue;

      const pngBuffer = encodeRgbToPng(imgObj);
      if (!pngBuffer) continue;

      // 扫描件页面通常只有一张全页图片
      // 非扫描件页面的图片是嵌入图表/截图
      results.push({
        pngBuffer,
        isFullPage: isScannedPage,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn('提取页面图片失败', {
        module: 'PdfjsImageExtractor',
        pageNum,
        opIndex: i,
        error: errMsg,
      });
    }
  }

  return results;
}

/** resolveImageObject 的超时时间（毫秒） */
const RESOLVE_IMAGE_TIMEOUT_MS = 5000;

/**
 * 从页面对象库或内联参数解析图片对象
 *
 * 注意：pdfjs 的 page.objs.get(imgName, callback) 在某些异常 PDF 上可能永远不触发回调
 * （例如图片对象解析失败但未抛错），导致整个提取流程卡死。
 * 因此必须加超时保护，超时后返回 null 跳过该图片。
 */
async function resolveImageObject(
  page: PdfPageWithOps,
  args: unknown[],
  isInline: boolean,
): Promise<PdfImageObject | null> {
  if (isInline) {
    // paintInlineImageXObject: 图片数据直接在 args[0] 中
    const obj = args[0] as PdfImageObject | undefined;
    return obj || null;
  }

  // paintImageXObject: args[0] 是图片名称，需从 page.objs 获取
  const imgName = args[0] as string | undefined;
  if (!imgName || !page.objs) return null;

  // 用 Promise.race 加入超时保护，避免 pdfjs 回调永不触发导致卡死
  // S4-5 修复：保存 timer 引用，fetchPromise 先完成时清理 timer 避免悬空
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fetchPromise = new Promise<PdfImageObject | null>((resolve) => {
    let settled = false;
    const done = (val: PdfImageObject | null) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };

    try {
      const result = page.objs!.get(imgName, (obj: unknown) => {
        done(obj as PdfImageObject | null);
      });
      // 有些 pdfjs 版本同步返回对象
      if (result && typeof result === 'object') {
        done(result as PdfImageObject);
      }
    } catch {
      done(null);
    }
  });

  const timeoutPromise = new Promise<PdfImageObject | null>((resolve) => {
    timer = setTimeout(() => resolve(null), RESOLVE_IMAGE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 验证图片对象结构是否完整 */
function isValidImageObject(obj: unknown): obj is PdfImageObject {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.width === 'number' &&
    typeof o.height === 'number' &&
    typeof o.kind === 'number' &&
    o.data instanceof Uint8ClampedArray
  );
}

// ==================== PNG 编码器（无外部依赖） ====================

/**
 * 将 pdfjs 的图片对象编码为 PNG buffer
 *
 * 支持：
 * - RGB_24BPP (kind=2)：每像素 3 字节
 * - RGBA_32BPP (kind=3)：每像素 4 字节
 * - GRAY_1BPP (kind=1)：每像素 1 bit（暂不支持的格式返回 null）
 *
 * PNG 结构：signature + IHDR + IDAT(zlib) + IEND
 * 使用 Node.js 内置 zlib 模块压缩，无外部依赖。
 */
function encodeRgbToPng(img: PdfImageObject): Buffer | null {
  const { width, height, kind, data } = img;

  if (width <= 0 || height <= 0) return null;

  let channels: number;
  let rawData: Buffer;

  if (kind === IMAGE_KIND_RGB_24BPP) {
    channels = 3;
    rawData = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  } else if (kind === IMAGE_KIND_RGBA_32BPP) {
    channels = 4;
    rawData = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  } else if (kind === IMAGE_KIND_GRAY_1BPP) {
    // 1bit 灰度图暂不支持编码（需要位展开），跳过
    logger.debug('暂不支持的图片格式（1BPP 灰度），跳过', {
      module: 'PdfjsImageExtractor',
      kind,
      width,
      height,
    });
    return null;
  } else {
    logger.debug('未知图片格式，跳过', {
      module: 'PdfjsImageExtractor',
      kind,
      width,
      height,
    });
    return null;
  }

  // 验证数据长度
  const expectedLength = width * height * channels;
  if (rawData.length < expectedLength) {
    logger.warn('图片数据长度不匹配，跳过', {
      module: 'PdfjsImageExtractor',
      kind,
      width,
      height,
      channels,
      expectedLength,
      actualLength: rawData.length,
    });
    return null;
  }

  // 构造 PNG 原始数据：每行前加 filter 字节（0 = None）
  const rowSize = width * channels;
  const filteredData = Buffer.alloc((rowSize + 1) * height);
  for (let y = 0; y < height; y++) {
    filteredData[y * (rowSize + 1)] = 0; // filter: None
    rawData.copy(
      filteredData,
      y * (rowSize + 1) + 1,
      y * rowSize,
      y * rowSize + rowSize,
    );
  }

  // zlib 压缩
  const compressed = zlib.deflateSync(filteredData);

  // 组装 PNG 文件
  const png = Buffer.alloc(8 + 25 + (compressed.length + 12) + 12);
  let offset = 0;

  // PNG signature
  png.write('\x89PNG\r\n\x1a\n', offset, 'latin1');
  offset += 8;

  // IHDR chunk
  writeUInt32(png, offset, 13); // length
  offset += 4;
  png.write('IHDR', offset, 'latin1');
  offset += 4;
  writeUInt32(png, offset, width);
  offset += 4;
  writeUInt32(png, offset, height);
  offset += 4;
  png[offset++] = 8; // bit depth
  png[offset++] = channels === 4 ? 6 : channels === 3 ? 2 : 0; // color type
  png[offset++] = 0; // compression
  png[offset++] = 0; // filter
  png[offset++] = 0; // interlace
  const ihdrCrc = crc32(png, offset - 17, 17);
  writeUInt32(png, offset, ihdrCrc);
  offset += 4;

  // IDAT chunk
  writeUInt32(png, offset, compressed.length);
  offset += 4;
  png.write('IDAT', offset, 'latin1');
  offset += 4;
  compressed.copy(png, offset);
  offset += compressed.length;
  // S4-1 修复：IDAT 的 CRC 应覆盖 Type("IDAT") + Data(compressed)，而非仅 Data
  const idatStart = offset - 4 - compressed.length;
  const idatCrc = crc32(png, idatStart, 4 + compressed.length);
  writeUInt32(png, offset, idatCrc);
  offset += 4;

  // IEND chunk
  writeUInt32(png, offset, 0);
  offset += 4;
  png.write('IEND', offset, 'latin1');
  offset += 4;
  const iendCrc = crc32(png, offset - 4, 4);
  writeUInt32(png, offset, iendCrc);
  offset += 4;

  return png.slice(0, offset);
}

/** 大端写入 32 位无符号整数 */
function writeUInt32(buf: Buffer, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

// ==================== CRC32 ====================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** 计算 buffer 的 CRC32（PNG 规范要求） */
function crc32(buf: Buffer | Uint8Array, offset: number, length: number): number {
  let crc = 0xffffffff;
  for (let i = 0; i < length; i++) {
    crc = CRC_TABLE[(crc ^ buf[offset + i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ==================== pdfjs OPS 获取 ====================

/**
 * 从 pdfjs 运行时获取 OPS 常量
 *
 * pdfjs 的 PDFPageProxy.getOperatorList 返回的 fnArray 使用 OPS 常量值，
 * 这些值可能因版本不同而变化。通过运行时获取保证兼容性。
 */
async function getPdfjsOps(
  pdfDocument: PdfDocumentLike,
): Promise<PdfjsOps | null> {
  try {
    // 通过第一页的 getOperatorList 获取一个空操作列表
    // 然后从 pdfjs 模块获取 OPS 常量
    const pdfjs = await import('pdfjs-dist');
    const OPS = (pdfjs as unknown as { OPS?: Record<string, number> }).OPS;
    if (!OPS) return null;

    return {
      paintImageXObject: OPS.paintImageXObject,
      paintInlineImageXObject: OPS.paintInlineImageXObject,
      paintImageMaskXObject: OPS.paintImageMaskXObject,
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn('获取 pdfjs OPS 常量失败', {
      module: 'PdfjsImageExtractor',
      error: errMsg,
    });
    return null;
  }
}
