/**
 * 扫描件检测模块
 *
 * 职责：
 * 1. 遍历 PDF 每页的文本内容，统计字符数
 * 2. 字符数低于阈值的页面判定为扫描件页面
 * 3. 返回扫描件页码列表，供 pdf-pdfjs 渲染器使用
 *
 * 设计原理：
 * - 正常 PDF 页面每页至少有几百字符的可提取文本
 * - 扫描件 PDF 的页面是图片，pdfjs getTextContent 返回空或极少文本
 * - 阈值由 SCANNED_PDF_CHARS_THRESHOLD 控制（默认 50 字符/页）
 *
 * 不依赖 NestJS DI，直接导出函数供 document-parser 调用。
 */

import { logger } from './logger.js';
import { config } from './config.js';

/**
 * pdfjs PDFDocumentProxy 的最小接口声明
 *
 * 避免直接引用 pdfjs-dist 的类型（该包的 .d.ts 在 Node.js 环境下
 * 类型推导较重，这里只声明扫描检测用到的 3 个方法）。
 */
export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNum: number): Promise<PdfPageLike>;
}

export interface PdfPageLike {
  getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
  cleanup(): Promise<void>;
}

/** 扫描件检测结果 */
export interface ScannedPdfDetectionResult {
  /** 扫描件页码列表（1-based） */
  scannedPageNumbers: number[];
  /** 总页数 */
  totalPages: number;
  /** 扫描件页面占比 */
  scannedRatio: number;
  /** 是否为扫描件 PDF（扫描页占比 > 50%） */
  isScannedPdf: boolean;
  /** 每页字符数统计 */
  pageCharCounts: number[];
}

/**
 * 检测 PDF 中的扫描件页面
 *
 * @param pdfDocument pdfjs 加载的 PDF 文档代理
 * @returns 检测结果
 */
export async function detectScannedPages(
  pdfDocument: PdfDocumentLike,
): Promise<ScannedPdfDetectionResult> {
  const threshold = config.scannedPdf.charsPerPageThreshold;
  const totalPages = pdfDocument.numPages;
  const pageCharCounts: number[] = [];
  const scannedPageNumbers: number[] = [];

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const page = await pdfDocument.getPage(pageNum);
    try {
      const textContent = await page.getTextContent();
      const charCount = textContent.items.reduce(
        (sum, item) => sum + (item.str?.length || 0),
        0,
      );
      pageCharCounts.push(charCount);

      if (charCount < threshold) {
        scannedPageNumbers.push(pageNum);
      }
    } finally {
      await page.cleanup();
    }
  }

  const scannedRatio = totalPages > 0 ? scannedPageNumbers.length / totalPages : 0;
  const isScannedPdf = scannedRatio > 0.5;

  logger.info('扫描件检测完成', {
    module: 'ScannedPdfDetector',
    totalPages,
    scannedPageCount: scannedPageNumbers.length,
    scannedRatio: Number(scannedRatio.toFixed(2)),
    isScannedPdf,
    threshold,
  });

  if (isScannedPdf) {
    logger.warn('检测到扫描件 PDF，将启用页面渲染提取图片', {
      module: 'ScannedPdfDetector',
      totalPages,
      scannedPageCount: scannedPageNumbers.length,
    });
  }

  return {
    scannedPageNumbers,
    totalPages,
    scannedRatio,
    isScannedPdf,
    pageCharCounts,
  };
}

/**
 * 判断是否需要扫描件检测（开关开启）
 */
export function isScannedPdfDetectionEnabled(): boolean {
  return config.scannedPdf.enabled;
}
