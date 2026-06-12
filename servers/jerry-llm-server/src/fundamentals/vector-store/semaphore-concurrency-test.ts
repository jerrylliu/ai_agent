/**
 * 嵌入信号量并发测试
 *
 * 模拟多个知识源同步 + 文档上传同时触发 addDocuments 的场景，
 * 验证信号量是否正确控制并发，确保同一时刻只有 MAX_EMBEDDING_CONCURRENCY 个嵌入请求在执行。
 *
 * 运行方式：npx tsx src/fundamentals/vector-store/semaphore-concurrency-test.ts
 */

// ==================== 信号量实现（独立副本，不依赖 ChromaDB/Ollama） ====================

class Semaphore {
  private queue: Array<{ resolve: () => void; callerId: string; enqueuedAt: number }> = [];
  private running = 0;
  private nextCallerId = 0;
  private log: Array<Record<string, any>> = [];

  constructor(private max: number) {}

  async acquire(callerTag?: string): Promise<string> {
    const callerId = callerTag ?? `caller_${this.nextCallerId++}`;

    if (this.running < this.max) {
      this.running++;
      this.log.push({
        event: 'acquire_immediate',
        callerId,
        running: this.running,
        max: this.max,
        queueLength: this.queue.length,
        ts: Date.now(),
      });
      return callerId;
    }

    const enqueuedAt = Date.now();
    this.log.push({
      event: 'acquire_queued',
      callerId,
      running: this.running,
      max: this.max,
      queueLength: this.queue.length + 1,
      ts: Date.now(),
    });

    return new Promise<string>((resolve) => {
      this.queue.push({ resolve: () => resolve(callerId), callerId, enqueuedAt });
    });
  }

  release(callerId: string): void {
    this.running--;

    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      const waitMs = Date.now() - next.enqueuedAt;
      this.running++;
      this.log.push({
        event: 'release_awaken',
        releasedBy: callerId,
        awakened: next.callerId,
        waitMs,
        running: this.running,
        queueLength: this.queue.length,
        ts: Date.now(),
      });
      next.resolve();
    } else {
      this.log.push({
        event: 'release_idle',
        releasedBy: callerId,
        running: this.running,
        queueLength: 0,
        ts: Date.now(),
      });
    }
  }

  getStatus(): { running: number; max: number; queueLength: number } {
    return { running: this.running, max: this.max, queueLength: this.queue.length };
  }

  getLog(): Array<Record<string, any>> {
    return this.log;
  }
}

// ==================== 模拟 addDocuments ====================

/**
 * 模拟一次 addDocuments 调用
 * 每次调用会持有信号量一段时间（模拟嵌入耗时）
 */
async function mockAddDocuments(
  semaphore: Semaphore,
  tag: string,
  holdMs: number,
): Promise<{ tag: string; startMs: number; endMs: number; waitMs: number }> {
  const acquireStart = Date.now();
  const callerId = await semaphore.acquire(tag);
  const waitMs = Date.now() - acquireStart;
  const startMs = Date.now();

  // 模拟嵌入耗时
  await new Promise((resolve) => setTimeout(resolve, holdMs));

  semaphore.release(callerId);
  const endMs = Date.now();

  return { tag, startMs, endMs, waitMs };
}

// ==================== 测试用例 ====================

async function testConcurrency1(): Promise<boolean> {
  console.log('\n========================================');
  console.log('测试 1：MAX_CONCURRENCY=1，5 个并发任务');
  console.log('预期：同一时刻只有 1 个任务在执行，其余排队\n');
  console.log('========================================');

  const semaphore = new Semaphore(1);
  const holdMs = 200; // 每个任务持有 200ms

  // 同时启动 5 个任务
  const tasks = [
    mockAddDocuments(semaphore, '知识源A-同步', holdMs),
    mockAddDocuments(semaphore, '文档上传-1', holdMs),
    mockAddDocuments(semaphore, '知识源B-同步', holdMs),
    mockAddDocuments(semaphore, '文档上传-2', holdMs),
    mockAddDocuments(semaphore, '知识源C-同步', holdMs),
  ];

  const results = await Promise.all(tasks);

  // 验证：任何时刻 running <= 1
  // 通过检查时间线来验证
  const timeline: Array<{ tag: string; startMs: number; endMs: number; waitMs: number }> = results;
  const baseTs = Math.min(...timeline.map((r) => r.startMs));

  console.log('\n执行时间线：');
  for (const r of timeline) {
    const startOffset = r.startMs - baseTs;
    const endOffset = r.endMs - baseTs;
    const bar = '█'.repeat(Math.round((r.endMs - r.startMs) / 10));
    const waitBar = r.waitMs > 0 ? `⏳等待${r.waitMs}ms` : '立即执行';
    console.log(`  ${r.tag.padEnd(16)} | ${startOffset.toString().padStart(4)}ms - ${endOffset.toString().padStart(4)}ms | ${bar} | ${waitBar}`);
  }

  // 检查是否有重叠（同一时刻有多个任务在执行）
  let maxOverlap = 0;
  const events: Array<{ ts: number; delta: number }> = [];
  for (const r of timeline) {
    events.push({ ts: r.startMs, delta: 1 });
    events.push({ ts: r.endMs, delta: -1 });
  }
  events.sort((a, b) => a.ts - b.ts);

  let currentOverlap = 0;
  for (const e of events) {
    currentOverlap += e.delta;
    maxOverlap = Math.max(maxOverlap, currentOverlap);
  }

  const passed = maxOverlap <= 1;
  console.log(`\n最大并发数: ${maxOverlap} (限制: 1) → ${passed ? '✅ 通过' : '❌ 失败'}`);

  // 打印信号量日志
  console.log('\n信号量日志：');
  for (const entry of semaphore.getLog()) {
    console.log(`  [${entry.event}] ${JSON.stringify({ ...entry, ts: undefined })}`);
  }

  return passed;
}

async function testConcurrency2(): Promise<boolean> {
  console.log('\n========================================');
  console.log('测试 2：MAX_CONCURRENCY=2，6 个并发任务');
  console.log('预期：同一时刻最多 2 个任务在执行\n');
  console.log('========================================');

  const semaphore = new Semaphore(2);
  const holdMs = 150;

  const tasks = [
    mockAddDocuments(semaphore, '知识源A', holdMs),
    mockAddDocuments(semaphore, '知识源B', holdMs),
    mockAddDocuments(semaphore, '文档上传-1', holdMs),
    mockAddDocuments(semaphore, '文档上传-2', holdMs),
    mockAddDocuments(semaphore, '知识源C', holdMs),
    mockAddDocuments(semaphore, '文档上传-3', holdMs),
  ];

  const results = await Promise.all(tasks);

  const timeline = results;
  const baseTs = Math.min(...timeline.map((r) => r.startMs));

  console.log('\n执行时间线：');
  for (const r of timeline) {
    const startOffset = r.startMs - baseTs;
    const endOffset = r.endMs - baseTs;
    const bar = '█'.repeat(Math.round((r.endMs - r.startMs) / 10));
    const waitBar = r.waitMs > 0 ? `⏳等待${r.waitMs}ms` : '立即执行';
    console.log(`  ${r.tag.padEnd(16)} | ${startOffset.toString().padStart(4)}ms - ${endOffset.toString().padStart(4)}ms | ${bar} | ${waitBar}`);
  }

  let maxOverlap = 0;
  const events: Array<{ ts: number; delta: number }> = [];
  for (const r of timeline) {
    events.push({ ts: r.startMs, delta: 1 });
    events.push({ ts: r.endMs, delta: -1 });
  }
  events.sort((a, b) => a.ts - b.ts);

  let currentOverlap = 0;
  for (const e of events) {
    currentOverlap += e.delta;
    maxOverlap = Math.max(maxOverlap, currentOverlap);
  }

  const passed = maxOverlap <= 2;
  console.log(`\n最大并发数: ${maxOverlap} (限制: 2) → ${passed ? '✅ 通过' : '❌ 失败'}`);

  return passed;
}

async function testSequential(): Promise<boolean> {
  console.log('\n========================================');
  console.log('测试 3：MAX_CONCURRENCY=1，顺序执行（无并发）');
  console.log('预期：无排队，所有任务立即执行\n');
  console.log('========================================');

  const semaphore = new Semaphore(1);

  // 顺序执行，不并发
  const results: Array<{ tag: string; startMs: number; endMs: number; waitMs: number }> = [];

  for (let i = 0; i < 3; i++) {
    const result = await mockAddDocuments(semaphore, `顺序任务-${i + 1}`, 50);
    results.push(result);
  }

  const allImmediate = results.every((r) => r.waitMs < 10);
  console.log(`所有任务立即执行: ${allImmediate ? '✅ 通过' : '❌ 失败'}`);

  // 检查信号量日志：不应有 queued 事件
  const log = semaphore.getLog();
  const queuedEvents = log.filter((e) => e.event === 'acquire_queued');
  const noQueue = queuedEvents.length === 0;
  console.log(`无排队事件: ${noQueue ? '✅ 通过' : '❌ 失败'}`);

  return allImmediate && noQueue;
}

async function testMixedScenario(): Promise<boolean> {
  console.log('\n========================================');
  console.log('测试 4：模拟真实场景 — 3 个知识源同步 + 2 个文档上传并发');
  console.log('MAX_CONCURRENCY=1，预期排队执行\n');
  console.log('========================================');

  const semaphore = new Semaphore(1);

  // 知识源同步：每个源有多个页面，每个页面调用一次 addDocuments
  // 文档上传：每个文档调用一次 addDocuments
  const tasks: Promise<{ tag: string; startMs: number; endMs: number; waitMs: number }>[] = [];

  // 知识源 A：3 个页面
  for (let i = 0; i < 3; i++) {
    tasks.push(mockAddDocuments(semaphore, `知识源A-页面${i + 1}`, 100 + Math.random() * 100));
  }

  // 知识源 B：2 个页面
  for (let i = 0; i < 2; i++) {
    tasks.push(mockAddDocuments(semaphore, `知识源B-页面${i + 1}`, 100 + Math.random() * 100));
  }

  // 知识源 C：4 个页面
  for (let i = 0; i < 4; i++) {
    tasks.push(mockAddDocuments(semaphore, `知识源C-页面${i + 1}`, 100 + Math.random() * 100));
  }

  // 文档上传 1
  tasks.push(mockAddDocuments(semaphore, '文档上传-合同.pdf', 150));

  // 文档上传 2
  tasks.push(mockAddDocuments(semaphore, '文档上传-手册.docx', 200));

  const results = await Promise.all(tasks);

  const baseTs = Math.min(...results.map((r) => r.startMs));

  console.log('\n执行时间线：');
  for (const r of results.sort((a, b) => a.startMs - b.startMs)) {
    const startOffset = r.startMs - baseTs;
    const endOffset = r.endMs - baseTs;
    const bar = '█'.repeat(Math.round((r.endMs - r.startMs) / 10));
    const waitBar = r.waitMs > 0 ? `⏳${r.waitMs}ms` : '立即';
    console.log(`  ${r.tag.padEnd(20)} | ${startOffset.toString().padStart(4)}ms - ${endOffset.toString().padStart(4)}ms | ${bar} | ${waitBar}`);
  }

  // 验证最大并发
  let maxOverlap = 0;
  const events: Array<{ ts: number; delta: number }> = [];
  for (const r of results) {
    events.push({ ts: r.startMs, delta: 1 });
    events.push({ ts: r.endMs, delta: -1 });
  }
  events.sort((a, b) => a.ts - b.ts);

  let currentOverlap = 0;
  for (const e of events) {
    currentOverlap += e.delta;
    maxOverlap = Math.max(maxOverlap, currentOverlap);
  }

  const passed = maxOverlap <= 1;
  console.log(`\n最大并发数: ${maxOverlap} (限制: 1) → ${passed ? '✅ 通过' : '❌ 失败'}`);

  // 统计排队情况
  const log = semaphore.getLog();
  const queuedCount = log.filter((e) => e.event === 'acquire_queued').length;
  const awakenCount = log.filter((e) => e.event === 'release_awaken').length;
  console.log(`排队次数: ${queuedCount}, 唤醒次数: ${awakenCount}`);

  return passed;
}

// ==================== 运行所有测试 ====================

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  嵌入信号量并发测试                           ║');
  console.log('║  验证 addDocuments 并发控制是否生效           ║');
  console.log('╚══════════════════════════════════════════════╝');

  const results: Array<{ name: string; passed: boolean }> = [];

  results.push({ name: '测试1: MAX=1, 5并发', passed: await testConcurrency1() });
  results.push({ name: '测试2: MAX=2, 6并发', passed: await testConcurrency2() });
  results.push({ name: '测试3: 顺序执行', passed: await testSequential() });
  results.push({ name: '测试4: 真实场景模拟', passed: await testMixedScenario() });

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  测试结果汇总                                 ║');
  console.log('╚══════════════════════════════════════════════╝');

  for (const r of results) {
    console.log(`  ${r.passed ? '✅' : '❌'} ${r.name}`);
  }

  const allPassed = results.every((r) => r.passed);
  console.log(`\n总计: ${results.filter((r) => r.passed).length}/${results.length} 通过 → ${allPassed ? '✅ 全部通过' : '❌ 存在失败'}`);

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('测试执行失败:', err);
  process.exit(1);
});
