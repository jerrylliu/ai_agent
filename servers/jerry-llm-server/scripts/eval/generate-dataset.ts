/**
 * 离线评估数据集生成脚本
 *
 * 从知识库中读取所有文档，按 documentId 分组，
 * 对每个文档用 LLM 生成 2-3 个查询，组成 (query, expectedDocIds) 数据集。
 *
 * 用法：
 *   pnpm ts-node scripts/eval/generate-dataset.ts
 *   pnpm ts-node scripts/eval/generate-dataset.ts -- --model=deepseek:deepseek-v4-flash --target=200
 *
 * 输出：scripts/eval/dataset.json（覆盖现有文件）
 */
import 'dotenv/config';
import { getAllDocuments } from '../../src/fundamentals/vector-store/index.js';
import { createRateLimitedLLM, buildModelConfig } from '../../src/fundamentals/model-provider.js';
import { HumanMessage } from '@langchain/core/messages';
import { parseLlmJson } from '../../src/fundamentals/llm-json-parser.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

// ==================== 类型定义 ====================

interface DatasetSample {
  id: string;
  query: string;
  expectedDocIds: string[];
  category: string;
  difficulty: string;
  note?: string;
}

interface Dataset {
  version: string;
  description: string;
  generatedAt: string;
  totalCount: number;
  kValues: number[];
  samples: DatasetSample[];
}

// ==================== LLM 生成查询的 Schema ====================

const GeneratedQueriesSchema = z.object({
  queries: z.array(
    z.object({
      query: z.string().describe('基于文档内容生成的查询文本'),
      category: z.enum(['entity', 'semantic', 'multi-entity', 'image']).describe('查询分类'),
      difficulty: z.enum(['easy', 'medium', 'hard']).describe('查询难度'),
    }),
  ).describe('生成的查询列表'),
});

// ==================== 生成查询的 Prompt ====================

const GENERATE_PROMPT = `你是一个检索评估数据集生成专家。基于以下文档内容，生成 __QPD__ 个用户可能提出的查询，这些查询的答案应该能在该文档中找到。

要求：
1. 查询必须能从文档内容中找到答案
2. 覆盖不同难度：easy（直接关键词匹配）、medium（需要语义理解）、hard（需要推理或综合）
3. 覆盖不同分类：
   - entity：实体查询，包含明确的关键词
   - semantic：语义查询，用自然语言描述需求，无明确关键词
   - multi-entity：跨实体查询，涉及多个概念关联
   - image：图片相关查询（仅当文档包含图片描述时使用）
4. 查询用中文，模拟真实用户提问方式
5. 输出严格的 JSON 格式

示例输出：
{"queries": [{"query": "Function Calling 是什么", "category": "entity", "difficulty": "easy"}, {"query": "心跳保活机制怎么做", "category": "semantic", "difficulty": "medium"}, {"query": "Agent 调用工具失败后怎么处理", "category": "multi-entity", "difficulty": "hard"}]}

文档内容（前 800 字）：
__CONTENT__

请基于上述文档生成 __QPD__ 个查询，只输出 JSON：`;

// ==================== 主流程 ====================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modelId = parseArg(args, '--model') || 'deepseek:deepseek-v4-flash';
  const targetCount = parseInt(parseArg(args, '--target') || '200', 10);
  const queriesPerDoc = parseInt(parseArg(args, '--qpd') || '3', 10);

  console.log('=== 离线评估数据集生成 ===\n');
  console.log(`模型: ${modelId}`);
  console.log(`目标样本数: ${targetCount}`);
  console.log(`每文档生成查询数: ${queriesPerDoc}\n`);

  // 1. 读取知识库所有文档
  console.log('正在读取知识库文档...');
  const allDocs = await getAllDocuments();
  console.log(`知识库共 ${allDocs.length} 个文本块`);

  if (allDocs.length === 0) {
    console.error('知识库为空，无法生成数据集。请先上传文档到知识库。');
    process.exit(1);
  }

  // 2. 按 documentId 分组
  const docGroups = new Map<string, typeof allDocs>();
  for (const doc of allDocs) {
    const docId = String(doc.metadata?.documentId || doc.metadata?.doc_id || 'unknown');
    if (!docGroups.has(docId)) {
      docGroups.set(docId, []);
    }
    docGroups.get(docId)!.push(doc);
  }

  console.log(`共 ${docGroups.size} 个独立文档\n`);

  // 3. 对每个文档生成查询
  const samples: DatasetSample[] = [];
  const model = createRateLimitedLLM(buildModelConfig(modelId));
  let sampleIdCounter = 1;

  console.log('开始生成查询...\n');

  for (const [docId, chunks] of docGroups) {
    if (docId === 'unknown' || docId === 'legacy') {
      console.log(`  跳过文档 ${docId}（无有效 documentId）`);
      continue;
    }

    // 取第一个 chunk 的内容作为代表（截断到 800 字避免 token 过多）
    const content = chunks[0]?.content?.substring(0, 800) || '';
    if (!content.trim()) {
      console.log(`  跳过文档 ${docId}（内容为空）`);
      continue;
    }

    try {
      const prompt = GENERATE_PROMPT.replace('__QPD__', String(queriesPerDoc)).replace('__CONTENT__', content);
      const response = await model.invoke([new HumanMessage(prompt)]);
      const responseText = typeof response === 'string' ? response : (response as any).content || '';

      const parsed = parseLlmJson(responseText, GeneratedQueriesSchema, {
        module: 'GenerateDataset',
      });

      if (!parsed.success) {
        console.log(`  文档 ${docId}: LLM 输出解析失败，跳过`);
        continue;
      }

      for (const q of parsed.data.queries) {
        samples.push({
          id: `q${String(sampleIdCounter).padStart(3, '0')}`,
          query: q.query,
          expectedDocIds: [docId],
          category: q.category,
          difficulty: q.difficulty,
          note: `自动生成，来源文档 ${docId}`,
        });
        sampleIdCounter++;
      }

      console.log(`  文档 ${docId}: 生成 ${parsed.data.queries.length} 个查询`);
    } catch (error: any) {
      console.error(`  文档 ${docId}: 生成失败 - ${error.message}`);
    }

    // 达到目标数量则停止
    if (samples.length >= targetCount) {
      console.log(`\n已达到目标样本数 ${targetCount}，停止生成。`);
      break;
    }
  }

  // 4. 输出数据集
  const dataset: Dataset = {
    version: '1.0',
    description: `离线评估数据集 - 从知识库自动生成，共 ${samples.length} 条样本`,
    generatedAt: new Date().toISOString(),
    totalCount: samples.length,
    kValues: [1, 3, 5, 10],
    samples: samples.slice(0, targetCount),
  };

  const outputPath = path.join(__dirname, 'dataset.json');
  fs.writeFileSync(outputPath, JSON.stringify(dataset, null, 2), 'utf-8');

  console.log(`\n=== 生成完成 ===`);
  console.log(`总样本数: ${dataset.samples.length}`);
  console.log(`输出文件: ${outputPath}`);

  // 按分类统计
  const categoryStats: Record<string, number> = {};
  for (const s of dataset.samples) {
    categoryStats[s.category] = (categoryStats[s.category] || 0) + 1;
  }
  console.log('\n按分类统计:');
  for (const [cat, count] of Object.entries(categoryStats)) {
    console.log(`  ${cat}: ${count}`);
  }
}

// ==================== 命令行参数解析 ====================

function parseArg(args: string[], prefix: string): string | undefined {
  for (const arg of args) {
    if (arg.startsWith(`${prefix}=`)) {
      return arg.substring(prefix.length + 1);
    }
  }
  return undefined;
}

main().catch((err) => {
  console.error('数据集生成失败:', err);
  process.exit(1);
});
