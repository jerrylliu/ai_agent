/**
 * import-progress / disk-water 验证脚本（S2.4 断点续传 + 磁盘熔断）
 *
 * 运行：pnpm --filter jerry-llm-server bench:verify-progress
 * 或：  node --import ./scripts/ts-loader.mjs --experimental-transform-types scripts/bench/verify-progress.ts
 *
 * 校验项：
 *   1. readImportProgress：不存在返回 null / JSON 损坏抛错 / schema 不符抛错
 *   2. writeImportProgress：原子写往返一致、目录自动创建、无 .tmp 残留
 *   3. disk-water 纯函数：gbToBytes / bytesToGb / driveFromPath
 *   4. getDriveFreeBytes：真实 PowerShell 探测本机盘（正值）
 *   5. checkDiskWater：ok 场景 / 阈值过高触发违规 / 不存在盘符 fail-closed
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readImportProgress,
  writeImportProgress,
  type ImportProgress,
} from './lib/import-progress.js';
import {
  gbToBytes,
  bytesToGb,
  driveFromPath,
  getDriveFreeBytes,
  checkDiskWater,
  type DiskWaterConfig,
} from './lib/disk-water.js';

// ==================== 极简断言框架（同 verify-loader.ts） ====================

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// ==================== 测试数据 ====================

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-progress-'));

function makeProgress(overrides: Partial<ImportProgress> = {}): ImportProgress {
  return {
    version: 1,
    runFingerprint: { sourceType: 'hubspot', limit: 100 },
    bm25Engine: 'tantivy',
    docsConsumed: 50,
    batchesCompleted: 1,
    stats: {
      docsImported: 48,
      docsSkipped: 1,
      docsFailed: 1,
      docsRepaired: 0,
      chunksAdded: 96,
      embedCalls: 96,
    },
    status: 'in_progress',
    updatedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  };
}

// ==================== 1. readImportProgress ====================

function testRead(): void {
  section('1. readImportProgress');
  check(
    '不存在的文件返回 null',
    readImportProgress(path.join(TMP_ROOT, 'no-such-dir', 'progress.json')) === null,
  );

  const corruptPath = path.join(TMP_ROOT, 'corrupt', 'progress.json');
  fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
  fs.writeFileSync(corruptPath, '{ not valid json', 'utf-8');
  let corruptMsg = '';
  try {
    readImportProgress(corruptPath);
  } catch (err) {
    corruptMsg = err instanceof Error ? err.message : String(err);
  }
  check('JSON 损坏抛错', corruptMsg.includes('不是合法 JSON'), corruptMsg);
  check('损坏错误信息含删除提示', corruptMsg.includes('请删除该文件后重新导入'), corruptMsg);

  const badSchemaPath = path.join(TMP_ROOT, 'bad-schema', 'progress.json');
  fs.mkdirSync(path.dirname(badSchemaPath), { recursive: true });
  fs.writeFileSync(
    badSchemaPath,
    JSON.stringify({ version: 99, bm25Engine: 'elasticsearch' }),
    'utf-8',
  );
  let schemaMsg = '';
  try {
    readImportProgress(badSchemaPath);
  } catch (err) {
    schemaMsg = err instanceof Error ? err.message : String(err);
  }
  check('schema 不符抛错', schemaMsg.includes('结构校验失败'), schemaMsg);
}

// ==================== 2. writeImportProgress 往返 ====================

function testWriteRoundtrip(): void {
  section('2. writeImportProgress 原子写往返');
  const filePath = path.join(TMP_ROOT, 'nested', 'deep', 'progress.json');
  const progress = makeProgress();
  writeImportProgress(filePath, progress);

  check('目录不存在时自动创建', fs.existsSync(filePath));
  const readBack = readImportProgress(filePath);
  check(
    '往返内容一致',
    JSON.stringify(readBack) === JSON.stringify(progress),
    JSON.stringify(readBack),
  );
  check(
    '无 .tmp 残留',
    !fs.existsSync(`${filePath}.tmp`),
  );

  // 覆盖写（模拟下一批 checkpoint）
  const next = makeProgress({ docsConsumed: 100, batchesCompleted: 2 });
  writeImportProgress(filePath, next);
  const readNext = readImportProgress(filePath);
  check('覆盖写生效', readNext?.docsConsumed === 100 && readNext?.batchesCompleted === 2);

  // completed / aborted 状态均可写
  writeImportProgress(filePath, makeProgress({ status: 'completed' }));
  check('completed 状态可写', readImportProgress(filePath)?.status === 'completed');
  writeImportProgress(filePath, makeProgress({ status: 'aborted' }));
  check('aborted 状态可写', readImportProgress(filePath)?.status === 'aborted');
}

// ==================== 3. disk-water 纯函数 ====================

function testPureFunctions(): void {
  section('3. disk-water 纯函数');
  check('gbToBytes(8) = 8GiB', gbToBytes(8) === 8 * 1024 * 1024 * 1024);
  check('bytesToGb 两位小数', bytesToGb(1536 * 1024 * 1024) === 1.5);
  check("driveFromPath Windows 反斜杠 → 'E'", driveFromPath('E:\\ragatest\\chroma') === 'E');
  check("driveFromPath 正斜杠 → 'D'", driveFromPath('D:/data/chroma') === 'D');
  check("driveFromPath 小写盘符归一化 → 'C'", driveFromPath('c:\\temp') === 'C');
  check('driveFromPath 相对路径 → null', driveFromPath('./chroma') === null);
  check('driveFromPath UNC 路径 → null', driveFromPath('\\\\server\\share') === null);
}

// ==================== 4. getDriveFreeBytes 真实探测 ====================

async function testProbe(): Promise<string> {
  section('4. getDriveFreeBytes（真实 PowerShell 探测）');
  // 用临时目录所在盘做真实探测（本机必然存在）
  const drive = driveFromPath(TMP_ROOT);
  if (!drive) {
    check('临时目录盘符解析', false, `TMP_ROOT=${TMP_ROOT}`);
    return 'C';
  }
  const free = await getDriveFreeBytes(drive);
  check(`${drive}: 盘探测返回正值`, free !== null && free > 0, `free=${free}`);
  console.log(`     ${drive}: 剩余 ${bytesToGb(free ?? 0)} GB`);

  // 不存在的盘符应抛错（fail-closed 的上游行为）
  let errMsg = '';
  try {
    await getDriveFreeBytes('Z');
  } catch (err) {
    errMsg = err instanceof Error ? err.message : String(err);
  }
  check('不存在的盘符抛错', errMsg.length > 0, errMsg);
  return drive;
}

// ==================== 5. checkDiskWater 场景 ====================

async function testCheckScenarios(probeDrive: string): Promise<void> {
  section('5. checkDiskWater 场景');
  const baseCfg: DiskWaterConfig = {
    mainDrive: probeDrive,
    healthDrive: probeDrive, // 同盘去重：只探测一次
    minFreeBytes: gbToBytes(0.0001), // 极低阈值 → 必然 ok
  };
  const ok = await checkDiskWater(baseCfg);
  check('低阈值 → ok', ok.ok && ok.violations.length === 0, JSON.stringify(ok.violations));
  check('同盘去重只探一次', ok.drives.length === 1, `drives=${ok.drives.length}`);

  const tooHigh = await checkDiskWater({
    ...baseCfg,
    minFreeBytes: gbToBytes(999999),
  });
  check('阈值过高 → 不 ok', !tooHigh.ok);
  check(
    '违规信息含"剩余"与"阈值"',
    tooHigh.violations.some((v) => v.includes('剩余') && v.includes('阈值')),
    JSON.stringify(tooHigh.violations),
  );

  const badDrive = await checkDiskWater({
    mainDrive: 'Z', // 不存在的盘 → 探测失败 → fail-closed
    healthDrive: probeDrive,
    minFreeBytes: gbToBytes(0.0001),
  });
  check('探测失败 fail-closed → 不 ok', !badDrive.ok);
  check(
    '违规信息含 fail-closed',
    badDrive.violations.some((v) => v.includes('fail-closed')),
    JSON.stringify(badDrive.violations),
  );
  check(
    '违规信息标注角色（主熔断盘）',
    badDrive.violations.some((v) => v.includes('主熔断盘')),
    JSON.stringify(badDrive.violations),
  );
}

// ==================== 主流程 ====================

async function main(): Promise<void> {
  console.log('import-progress / disk-water 验证开始');
  console.log(`临时目录: ${TMP_ROOT}`);
  try {
    testRead();
    testWriteRoundtrip();
    testPureFunctions();
    const probeDrive = await testProbe();
    await testCheckScenarios(probeDrive);
  } finally {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  }

  console.log(`\n========== 结果：通过 ${passed}，失败 ${failed} ==========`);
  if (failed > 0) {
    console.log('❌ 存在失败项，请检查上方输出');
    process.exit(1);
  }
  console.log('✅ 全部通过');
}

main();
