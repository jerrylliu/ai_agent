//整个文件是测试文件
import { OllamaEmbeddings } from "@langchain/ollama";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { logger } from './logger';
import { config } from './config';
// 创建 Ollama 嵌入模型实例
const embeddings = new OllamaEmbeddings({
  model: "bge-large", // 使用的嵌入模型,中文支持力度大.
  baseUrl: config.ollamaBaseUrl,
});

// 创建内存向量存储
const vectorStore = new MemoryVectorStore(embeddings);
//存储已添加的文档内容
const addedContents = new Set<string>();
// 主函数封装，解决顶层 await 问题
export async function main(message?: string) {
  // 添加文档到向量存储
  const documents = [
    {
      pageContent: "猫是一种可爱的小动物，常见的宠物，喜欢在家里活动，适合作为家庭宠物饲养，猫科动物，毛茸茸的，喜欢抓老鼠",
      metadata: { source: "宠物百科" }
    },
    {
      pageContent: "狗是人类最好的朋友，忠诚的伴侣动物，适合作为看门犬和家庭宠物，犬科动物，喜欢玩耍和陪伴主人",
      metadata: { source: "宠物百科" }
    },
    {
      pageContent: "Python 是一种流行的编程语言，广泛应用于数据分析、人工智能和Web开发，语法简洁易学",
      metadata: { source: "技术文档" }
    },
  ];
  // 过滤出未添加过的文档
  const newDocuments = documents.filter(doc => {
    if (addedContents.has(doc.pageContent)) {
      return false;
    }
    addedContents.add(doc.pageContent);
    return true;
  });

  if (newDocuments.length > 0) {
    await vectorStore.addDocuments(newDocuments);
  }
  // 执行相似性搜索
  const query = message || "什么动物适合当宠物？";
  // 使用向量存储进行相似性搜索，返回最相似的 3 个结果（带相似度分数）
  const results = await vectorStore.similaritySearchWithScore(query, 2);

  logger.debug('RAG 测试查询', { module: 'RagTest', query });
  results.forEach(([doc, score], index) => {
    logger.debug('RAG 测试结果', { module: 'RagTest', index: index + 1, content: doc.pageContent, score: score.toFixed(4) });
  });
}

// 调用主函数
main().catch(err => logger.error('RAG 测试失败', { module: 'RagTest', error: String(err) }));
