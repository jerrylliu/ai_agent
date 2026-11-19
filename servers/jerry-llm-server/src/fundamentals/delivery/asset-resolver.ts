/**
 * fc:// 资产权威解析器（两阶段交付·跨轮/跨重启兜底）
 *
 * 设计背景（2026-11-20 生产案例）：
 *   交付计划收口时 Workspace 只查"本轮收集数组"，但 FC 资产缓存机制允许模型
 *   复用历史轮次生成的 fc:// 地址（iteration 0 即带 4 个上轮产物引用登记），
 *   合法的跨轮引用被误判缺失 → 整封拒发。
 *
 * 权威存储与有效期：
 *   - fc://document/{key}  → 文档持久化服务（MySQL 元数据 + 文件存储，7 天有效）
 *   - fc://chart/{key}     → MultiLevelCache（L1 内存 + L2 Redis，TTL 内有效）
 *   - fc://mindmap/{key}   → MultiLevelCache（同上）
 *   - fc://image/{key}     → 无产生方（generate_image 返回 http 直链），恒 null
 *
 * 两个消费方：
 *   - prompt.ts 收口 Workspace：本轮数组未命中时的兜底
 *   - delivery-plan-store 补偿扫描：进程崩溃后内存数组已丢，纯权威存储解析
 *     （文档/缓存类引用在有效期内可正确发送，不再被"恒 null"误杀）
 *
 * 解析器内部已处理 Redis 降级（未命中返回 null 不抛异常），本模块不重复 try/catch。
 */

import { logger } from '../logger.js';
import { getCachedDocument } from '../tools/generate-document.js';
import {
  parseChartImageUrl,
  parseMindmapImageUrl,
} from '../tools/multimodal-output.js';
import type { ResolvedAsset } from './delivery-executor.js';

/**
 * 从权威存储解析 fc:// 内部协议引用
 * @param ref 形如 fc://document/{key} 的引用
 * @returns 存在性成立返回 { url: ref }（发送层的 downloadAttachmentToBase64
 *          自身支持 fc:// 协议，透传原引用即可）；解析不到返回 null
 */
export async function resolveFcAssetFromStores(
  ref: string,
): Promise<ResolvedAsset | null> {
  if (ref.startsWith('fc://document/')) {
    const doc = await getCachedDocument(ref);
    return doc ? { url: ref } : null;
  }
  if (ref.startsWith('fc://chart/')) {
    const option = await parseChartImageUrl(ref);
    return option ? { url: ref } : null;
  }
  if (ref.startsWith('fc://mindmap/')) {
    const code = await parseMindmapImageUrl(ref);
    return code ? { url: ref } : null;
  }
  // fc://image/ 无产生方：generate_image 返回 http 直链，不会出现该协议的产物
  logger.debug('资产权威解析：未知 fc:// 协议，返回 null', {
    module: 'DeliveryAssetResolver',
    ref,
  });
  return null;
}
