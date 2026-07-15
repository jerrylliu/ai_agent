/**
 * 模型能力探测脚本（命令行入口，供 CI / GitHub Actions 使用）
 *
 * 核心探测逻辑已抽取到 src/fundamentals/model-capability-prober.ts，
 * 此脚本只负责命令行参数解析和结果输出。
 *
 * 应用内也可通过 POST /models/probe 接口触发探测（使用内存中的 API Key）。
 *
 * 用法：
 *   pnpm probe                                              # 探测所有可用模型
 *   pnpm probe -- --model=deepseek:deepseek-v4-pro          # 只探测指定模型
 *   pnpm probe -- --deepseek-key=sk-xxx                     # 传入 DeepSeek API Key
 *   pnpm probe -- --zhipu-key=xxx                           # 传入智谱 API Key
 *   pnpm probe -- --deepseek-key=sk-xxx --model=deepseek:deepseek-v4-flash
 *
 * API Key 来源优先级：命令行参数 > 环境变量
 * 安全提醒：命令行传入的 Key 会出现在 shell history 中，建议探测完成后清理 history，
 *          或改用环境变量（下方列出的 *_API_KEY）。
 *
 * 环境变量（可选，当未通过命令行传 Key 时回退使用）：
 *   DEEPSEEK_API_KEY  - DeepSeek 模型 API Key
 *   ZHIPU_API_KEY     - 智谱模型 API Key
 *   OLLAMA_BASE_URL   - Ollama 服务地址（默认 http://localhost:11434）
 *   DEEPSEEK_BASE_URL - DeepSeek API 地址
 *   ZHIPU_BASE_URL    - 智谱 API 地址
 *
 * 输出：src/fundamentals/capabilities.json
 */
import {
  probeAllModels,
  saveCapabilitiesFile,
  type ProbeKeys,
} from '../src/fundamentals/model-capability-prober.js';

// ==================== 主流程 ====================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modelFilter = parseModelFilter(args);

  // 命令行传入的 API Key 作为 ProbeKeys 传给 probeAllModels
  // 共享模块内部按 keys > process.env 优先级读取
  const keys = parseApiKeyArgs(args);

  console.log('=== 模型能力探测开始 ===\n');

  const result = await probeAllModels(
    keys,
    (modelId, status, detail) => {
      if (status === 'probing') {
        console.log(`探测 ${modelId}...`);
      } else if (status === 'done') {
        console.log(`  → ${detail}`);
      } else if (status === 'skipped') {
        console.warn(`跳过 ${modelId}: ${detail}`);
      } else {
        console.error(`  → 探测失败，保留上次结果: ${detail}`);
      }
    },
    modelFilter,
  );

  saveCapabilitiesFile(result);

  console.log(`\n=== 探测完成 ===`);
  console.log(`结果已写入 src/fundamentals/capabilities.json`);
  console.log(`请检查 git diff 后提交。`);
}

// ==================== 命令行参数解析 ====================

function parseModelFilter(args: string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith('--model=')) {
      return arg.substring('--model='.length);
    }
  }
  return undefined;
}

/**
 * 解析命令行传入的 API Key 参数
 *
 * 支持的参数：
 *   --deepseek-key=sk-xxx
 *   --zhipu-key=xxx
 *
 * 返回的 key 会作为 ProbeKeys 传给 probeAllModels，优先级：命令行参数 > 环境变量
 */
function parseApiKeyArgs(args: string[]): ProbeKeys {
  const result: ProbeKeys = {};
  for (const arg of args) {
    if (arg.startsWith('--deepseek-key=')) {
      result.deepseek = arg.substring('--deepseek-key='.length);
    } else if (arg.startsWith('--zhipu-key=')) {
      result.zhipu = arg.substring('--zhipu-key='.length);
    }
  }
  return result;
}

main().catch((e) => {
  console.error('探测脚本异常退出:', e);
  process.exit(1);
});
