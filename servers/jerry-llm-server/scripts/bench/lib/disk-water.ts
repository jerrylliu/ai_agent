/**
 * 磁盘水位探测与熔断（benchmark-only，方案 §3.8.5 ⑥ / §4.3 / S2.4）
 *
 * 职责：探测指定盘符剩余空间，按阈值判定是否触发熔断。
 *
 * 🔴 熔断分级（方案 §3.8.5 ⑥）：
 *    - 主熔断盘：BM25 索引 + ChromaDB 持久化所在盘（从 CHROMA_PERSIST_DIR 派生），
 *      低于阈值 → 立即停写；
 *    - 健康门盘：语料源 D:\ragatest 所在盘（默认 D），启动时校验 + 运行中监控，
 *      低于阈值 → 拒绝启动 / 停写（语料盘虽只读，但同盘其他写入会挤占空间）。
 *
 * 🔴 fail-closed（方案红线：中止"不得静默继续"）：
 *    探测命令失败（盘符不存在 / PowerShell 异常）一律视为「不安全」，
 *    返回带 violation 的结果，由调用方按熔断处理 —— 绝不因探测失败而放行。
 *
 * 设计原则：
 *   1. 不引新依赖：Node 无内建跨平台磁盘 API，复用 child_process 调 PowerShell
 *      （本机实测 `(Get-PSDrive -Name X).Free` 返回剩余字节数）；
 *   2. 纯函数 + 显式入参，不 import config，便于单测与阈值覆盖（验收要求
 *      "人为把阈值调高触发熔断"）。
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ==================== 类型 ====================

/** 单盘探测结果 */
export interface DriveWater {
  /** 盘符（大写单字母，如 'E'） */
  drive: string;
  /** 剩余字节数；探测失败为 null */
  freeBytes: number | null;
  /** 探测/判定错误说明；正常为 null */
  error: string | null;
}

/** 熔断配置 */
export interface DiskWaterConfig {
  /** 主熔断盘符（BM25 + Chroma 持久化所在盘） */
  mainDrive: string;
  /** 健康门盘符（语料源所在盘，默认 D） */
  healthDrive: string;
  /** 剩余空间阈值（字节），低于即触发 */
  minFreeBytes: number;
  /** PowerShell 探测超时（毫秒），默认 10s */
  timeoutMs?: number;
}

/** 熔断判定结果 */
export interface DiskWaterResult {
  /** 是否安全（所有盘均高于阈值且探测成功） */
  ok: boolean;
  /** 各盘探测明细 */
  drives: DriveWater[];
  /** 触发熔断的原因列表（ok=true 时为空） */
  violations: string[];
}

// ==================== 工具函数 ====================

/** GB → 字节 */
export function gbToBytes(gb: number): number {
  return Math.round(gb * 1024 ** 3);
}

/** 字节 → GB（保留两位，仅用于日志展示） */
export function bytesToGb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 100) / 100;
}

/**
 * 从绝对路径派生盘符（Windows）。
 * @returns 大写单字母盘符（'E:\ragbench' → 'E'）；非 Windows 盘符路径返回 null
 */
export function driveFromPath(targetPath: string): string | null {
  const match = /^([A-Za-z]):[\\/]/.exec(targetPath);
  return match ? match[1].toUpperCase() : null;
}

/**
 * 探测单盘剩余字节数（PowerShell `Get-PSDrive`）。
 *
 * @throws 盘符非法 / 命令失败 / 输出无法解析为数字时抛错（fail-closed 由调用方兜底）
 */
export async function getDriveFreeBytes(drive: string, timeoutMs = 10000): Promise<number> {
  if (!/^[A-Za-z]$/.test(drive)) {
    throw new Error(`非法盘符: "${drive}"（应为单字母 A-Z）`);
  }
  // -NoProfile -NonInteractive：避免加载用户配置拖慢/阻塞；ErrorAction Stop：盘符不存在即报错
  const script = `(Get-PSDrive -Name '${drive.toUpperCase()}' -PSProvider FileSystem -ErrorAction Stop).Free`;
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: timeoutMs },
  );
  const freeBytes = Number(String(stdout).trim());
  if (!Number.isFinite(freeBytes) || freeBytes < 0) {
    throw new Error(`盘符 ${drive} 剩余空间解析失败: stdout="${stdout.trim()}"`);
  }
  return freeBytes;
}

// ==================== 熔断判定 ====================

/**
 * 探测主熔断盘 + 健康门盘，按阈值判定是否触发熔断。
 *
 * 🔴 fail-closed：任一盘探测失败（error 非空）即视为不安全，ok=false。
 * 两盘可能相同（如持久化与语料同在 D），去重后只探测一次。
 */
export async function checkDiskWater(cfg: DiskWaterConfig): Promise<DiskWaterResult> {
  const timeoutMs = cfg.timeoutMs ?? 10000;
  const violations: string[] = [];

  // 去重盘符，保留角色标签用于日志
  const roles = new Map<string, string[]>();
  roles.set(cfg.mainDrive.toUpperCase(), ['主熔断盘']);
  const health = cfg.healthDrive.toUpperCase();
  roles.set(health, [...(roles.get(health) ?? []), '健康门盘']);

  const drives: DriveWater[] = [];
  for (const [drive, labels] of roles) {
    let freeBytes: number | null = null;
    let error: string | null = null;
    try {
      freeBytes = await getDriveFreeBytes(drive, timeoutMs);
    } catch (e: any) {
      error = e?.message ?? String(e);
    }
    drives.push({ drive, freeBytes, error });

    const label = labels.join('/');
    if (error !== null) {
      // fail-closed：探测失败按熔断处理
      violations.push(`${label} ${drive}: 探测失败（${error}），fail-closed 视为不安全`);
    } else if (freeBytes !== null && freeBytes < cfg.minFreeBytes) {
      violations.push(
        `${label} ${drive}: 剩余 ${bytesToGb(freeBytes)}GB < 阈值 ${bytesToGb(cfg.minFreeBytes)}GB`,
      );
    }
  }

  return { ok: violations.length === 0, drives, violations };
}
