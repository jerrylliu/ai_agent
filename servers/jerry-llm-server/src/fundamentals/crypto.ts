/**
 * AES-256-GCM 对称加密工具
 *
 * 用于加密存储 API Key 等敏感凭据，避免明文驻留内存变量。
 *
 * 设计要点：
 *   1. 密钥来源：环境变量 ENCRYPTION_KEY（32 字节，hex 编码 = 64 字符）
 *   2. 密钥缺失时：开发环境自动生成临时密钥（每次重启不同，重启后旧密文不可解密），
 *      生产环境应固定配置 ENCRYPTION_KEY
 *   3. 加密算法：AES-256-GCM（带认证标签，防篡改）
 *   4. 密文格式：`iv:authTag:ciphertext`（均 hex 编码，可直接存字符串变量）
 *
 * 安全说明：
 *   - GCM 模式的 IV（初始化向量）每次加密随机生成，同一明文每次加密出的密文不同
 *   - AuthTag 防止密文被篡改：解密时若 tag 不匹配会抛错
 *   - 临时密钥仅用于开发环境，生产环境必须配置固定 ENCRYPTION_KEY
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { logger } from './logger.js';

/** 密钥字节长度（AES-256 = 32 字节） */
const KEY_BYTES = 32;
/** IV 字节长度（GCM 推荐 12 字节） */
const IV_BYTES = 12;

/** 主密钥（启动时从环境变量加载，或开发环境自动生成） */
let masterKey: Buffer;

/**
 * 初始化主密钥
 *
 * 优先从 ENCRYPTION_KEY 环境变量加载（hex 编码）；
 * 未配置时生成随机密钥（仅适合开发环境，重启后旧密文不可解密）。
 */
function initMasterKey(): void {
  const envKey = process.env.ENCRYPTION_KEY;

  if (envKey && envKey.length === KEY_BYTES * 2) {
    masterKey = Buffer.from(envKey, 'hex');
    logger.info('加密主密钥已从 ENCRYPTION_KEY 加载', { module: 'CryptoUtil' });
    return;
  }

  if (envKey && envKey.length !== KEY_BYTES * 2) {
    logger.warn(
      `ENCRYPTION_KEY 长度应为 ${KEY_BYTES * 2} 字符（${KEY_BYTES} 字节 hex 编码），` +
      `当前长度 ${envKey.length}，将忽略并生成临时密钥`,
      { module: 'CryptoUtil' },
    );
  }

  // 开发环境兜底：生成临时密钥
  masterKey = randomBytes(KEY_BYTES);
  logger.warn(
    '未配置 ENCRYPTION_KEY，已生成临时加密密钥（重启后旧密文将无法解密，请生产环境配置 ENCRYPTION_KEY）',
    { module: 'CryptoUtil' },
  );
}

initMasterKey();

/**
 * 加密明文字符串
 *
 * @param plaintext 明文
 * @returns 密文（格式：`iv:authTag:ciphertext`，hex 编码）；输入为空时返回空字符串
 */
export function encrypt(plaintext: string): string {
  if (!plaintext) return '';

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

/**
 * 解密密文字符串
 *
 * @param ciphertext 密文（格式：`iv:authTag:ciphertext`）
 * @returns 明文；输入为空时返回空字符串；解密失败返回空字符串并记录警告
 */
export function decrypt(ciphertext: string): string {
  if (!ciphertext) return '';

  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
      logger.warn('密文格式错误（应为 iv:authTag:ciphertext）', { module: 'CryptoUtil' });
      return '';
    }

    const [ivHex, authTagHex, dataHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(dataHex, 'hex');

    const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch (e: any) {
    logger.warn('解密失败（可能是密钥变更或密文损坏）', {
      module: 'CryptoUtil',
      err: (e?.message || String(e)).slice(0, 200),
    });
    return '';
  }
}

/**
 * 判断一个值是否为加密后的密文（格式：`iv:authTag:ciphertext`）
 *
 * 用于兼容旧数据：如果存储的值不是密文格式，说明是历史明文，直接返回。
 */
export function isEncrypted(value: string): boolean {
  if (!value) return false;
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  // 检查每段都是合法的 hex 字符串
  return parts.every((part) => /^[0-9a-f]+$/i.test(part));
}
