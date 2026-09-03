/**
 * 文档注入静态扫描器（入库扫描门禁第一阶段）
 *
 * 职责：在不依赖 LLM 的情况下，对准备入库的文本做低成本、确定性的签名检测：
 * 1. 注入语义签名：复用 `prompt-injection-guard` 的 BLOCK / SUSPICIOUS 签名，
 *    保证"用户输入防线"与"入库内容防线"使用同一套签名，不产生双轨漂移
 * 2. 隐藏信道检测：零宽字符、双向控制符、同形异义字符、长 base64 载荷，
 *    这类内容通常肉眼不可见，专门用于夹带指令或绕过关键词签名
 *
 * 设计原则：
 * - 本模块是纯函数，不做任何持久化 / 状态机流转，编排逻辑由上层扫描服务负责
 * - 发现项不携带 chunkIndex（静态扫描可在全文或单 chunk 上运行），由调用方补齐
 * - 发现项数量有界（每条签名最多 1 条、隐藏信道各 1 条、base64 最多 3 条），
 *   避免超大文档产生海量 findings 撑爆存储与复核界面
 */

import type { ScanFinding } from '../entities/document-version.entity.js';
import {
  BLOCK_PATTERNS,
  SUSPICIOUS_PATTERNS,
} from './prompt-injection-guard.js';

// ==================== 常量 ====================

/** 证据摘录的命中点两侧半径（字符），供复核界面溯源展示 */
const EVIDENCE_RADIUS = 40;

/**
 * 正常文本几乎不会出现的零宽字符，出现即报：
 * - U+200B 零宽空格 / U+2060 词连接符 / U+FEFF 零宽不换行空格（BOM）
 * 常见用途：隐藏指令文本、拆分关键词以绕过签名匹配
 */
const ZERO_WIDTH_CRITICAL = /[\u200b\u2060\ufeff]/g;

/**
 * 零宽连接符（ZWNJ / ZWJ）在波斯语、印地语、emoji 中有合法用途，
 * 因此不按出现即报，而是超过阈值才报（正常文本极少超过 5 个）
 */
const ZERO_WIDTH_JOINERS = /[\u200c\u200d]/g;
const JOINER_THRESHOLD = 5;

/**
 * 双向（BiDi）控制字符：U+202A-202E（嵌入 / 覆盖方向）、U+2066-2069（隔离方向）
 * 用于"视觉误导"攻击：让代码 / 文本的显示顺序与逻辑顺序不一致，隐藏真实意图
 */
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;

/**
 * 拉丁字母与西里尔字母相邻混排（如用西里尔 "а" 冒充拉丁 "a"）
 * 同形异义字符攻击的典型特征，用于绕过关键词签名
 */
const HOMOGLYPH_MIX = /[A-Za-z][\u0400-\u04ff]|[\u0400-\u04ff][A-Za-z]/g;

/** 长 base64 样式字符串：可能是编码后的载荷，仅记录为 info 级，不影响裁决 */
const LONG_BASE64 = /[A-Za-z0-9+/]{80,}={0,2}/g;

/** info 级发现项的数量上限（只报前几处，够复核人判断即可） */
const MAX_INFO_FINDINGS = 3;

// ==================== 工具函数 ====================

/** 把不可见控制字符转成 [U+XXXX] 可见标记，避免证据片段在界面上"看起来什么都没有" */
function visualizeInvisibleChars(text: string): string {
  return text.replace(
    /[\u200b\u200c\u200d\u2060\ufeff\u202a-\u202e\u2066-\u2069]/g,
    (ch) => `[U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}]`,
  );
}

/** 提取命中点 ±40 字符的原文片段作为证据，首尾超出时加省略号 */
function extractEvidence(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EVIDENCE_RADIUS);
  const end = Math.min(text.length, index + length + EVIDENCE_RADIUS);
  const snippet = visualizeInvisibleChars(text.slice(start, end)).replace(
    /\s+/g,
    ' ',
  );
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${snippet}${suffix}`;
}

// ==================== 扫描实现 ====================

/** 注入语义签名扫描：命中 BLOCK 记为拦截级，命中 SUSPICIOUS 记为可疑级 */
function scanSignaturePatterns(text: string, findings: ScanFinding[]): void {
  for (const { pattern, reason } of BLOCK_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      findings.push({
        stage: 'static',
        severity: 'blocked',
        type: 'block-pattern',
        detail: `命中高危注入签名：${reason}`,
        evidence: extractEvidence(text, match.index, match[0].length),
      });
    }
  }
  for (const { pattern, reason } of SUSPICIOUS_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      findings.push({
        stage: 'static',
        severity: 'suspicious',
        type: 'suspicious-pattern',
        detail: `命中可疑注入签名：${reason}`,
        evidence: extractEvidence(text, match.index, match[0].length),
      });
    }
  }
}

/** 隐藏信道扫描：零宽字符 / 双向控制符 / 同形异义字符 / 长 base64 */
function scanHiddenChannels(text: string, findings: ScanFinding[]): void {
  // 1. 严格零宽字符：出现即报（可疑级，转人工复核确认是否为排版噪声）
  const zeroWidth = [...text.matchAll(ZERO_WIDTH_CRITICAL)];
  if (zeroWidth.length > 0) {
    const first = zeroWidth[0];
    findings.push({
      stage: 'static',
      severity: 'suspicious',
      type: 'zero-width',
      detail: `检测到 ${zeroWidth.length} 处零宽字符（常用于隐藏指令或拆分关键词签名）`,
      evidence: extractEvidence(text, first.index ?? 0, 1),
    });
  }

  // 2. 零宽连接符超阈值（低于阈值视为合法语言排版）
  const joiners = [...text.matchAll(ZERO_WIDTH_JOINERS)];
  if (joiners.length >= JOINER_THRESHOLD) {
    const first = joiners[0];
    findings.push({
      stage: 'static',
      severity: 'suspicious',
      type: 'zero-width-joiner',
      detail: `检测到 ${joiners.length} 处零宽连接符（超过阈值 ${JOINER_THRESHOLD}，疑似隐藏内容）`,
      evidence: extractEvidence(text, first.index ?? 0, 1),
    });
  }

  // 3. 双向控制符：出现即报（视觉误导攻击特征）
  const bidi = [...text.matchAll(BIDI_CONTROLS)];
  if (bidi.length > 0) {
    const first = bidi[0];
    findings.push({
      stage: 'static',
      severity: 'suspicious',
      type: 'bidi-control',
      detail: `检测到 ${bidi.length} 处双向控制字符（可使显示顺序与逻辑顺序不一致）`,
      evidence: extractEvidence(text, first.index ?? 0, 1),
    });
  }

  // 4. 拉丁 + 西里尔相邻混排（同形异义字符攻击）
  const homoglyphs = [...text.matchAll(HOMOGLYPH_MIX)];
  if (homoglyphs.length > 0) {
    const first = homoglyphs[0];
    findings.push({
      stage: 'static',
      severity: 'suspicious',
      type: 'homoglyph',
      detail: `检测到 ${homoglyphs.length} 处拉丁/西里尔字母混排（疑似同形异义字符绕过签名）`,
      evidence: extractEvidence(text, first.index ?? 0, first[0].length),
    });
  }

  // 5. 长 base64 载荷：仅记录（info 级，不参与裁决，供复核人参考）
  const base64Matches = [...text.matchAll(LONG_BASE64)].slice(
    0,
    MAX_INFO_FINDINGS,
  );
  for (const match of base64Matches) {
    findings.push({
      stage: 'static',
      severity: 'info',
      type: 'base64-payload',
      detail: '检测到长 base64 样式字符串（可能为编码载荷，仅记录不影响裁决）',
      evidence: extractEvidence(text, match.index ?? 0, match[0].length),
    });
  }
}

// ==================== 对外接口 ====================

/** 静态扫描结果 */
export interface StaticScanResult {
  /** 综合级别（不含 info 级）：存在拦截级 → blocked；仅有可疑级 → suspicious；否则 safe */
  level: 'blocked' | 'suspicious' | 'safe';
  /** 全部发现项（含 info 级） */
  findings: ScanFinding[];
}

/**
 * 对任意文本做静态注入扫描（可用于全文，也可用于单个 chunk）
 *
 * @param text 待扫描文本（空文本直接返回 safe）
 * @returns 综合级别 + 发现项列表；发现项不含 chunkIndex，由调用方按扫描上下文补齐
 */
export function staticScanContent(text: string): StaticScanResult {
  const body = text ?? '';
  const findings: ScanFinding[] = [];

  if (body.length > 0) {
    scanSignaturePatterns(body, findings);
    scanHiddenChannels(body, findings);
  }

  const level: StaticScanResult['level'] = findings.some(
    (f) => f.severity === 'blocked',
  )
    ? 'blocked'
    : findings.some((f) => f.severity === 'suspicious')
      ? 'suspicious'
      : 'safe';

  return { level, findings };
}
