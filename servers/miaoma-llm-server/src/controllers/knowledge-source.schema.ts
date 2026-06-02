import { z } from 'zod';

const WebConfigSchema = z.object({
  startUrl: z.string().url().optional(),
  url: z.string().url().optional(),
  includePatterns: z.array(z.string()).optional(),
  excludePatterns: z.array(z.string()).optional(),
}).refine(
  (data) => data.startUrl || data.url,
  { message: 'Web 类型知识源必须提供 startUrl 或 url', path: ['startUrl'] },
);

const FeishuConfigSchema = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  wikiSpaceId: z.string().optional(),
  docToken: z.string().optional(),
  includePatterns: z.array(z.string()).optional(),
  excludePatterns: z.array(z.string()).optional(),
  feishuDomain: z.string().optional(),
}).refine(
  (data) => data.wikiSpaceId || data.docToken,
  { message: '飞书类型知识源必须提供 wikiSpaceId 或 docToken', path: ['wikiSpaceId'] },
);

export const CreateKnowledgeSourceSchema = z.discriminatedUnion('type', [
  z.object({
    name: z.string().min(1, '名称不能为空'),
    type: z.literal('web'),
    config: WebConfigSchema,
    syncInterval: z.number().int().min(1).optional(),
    maxDepth: z.number().int().min(1).max(5).optional(),
    maxPages: z.number().int().min(1).optional(),
  }),
  z.object({
    name: z.string().min(1, '名称不能为空'),
    type: z.literal('feishu'),
    config: FeishuConfigSchema,
    syncInterval: z.number().int().min(1).optional(),
    maxDepth: z.number().int().min(1).max(5).optional(),
    maxPages: z.number().int().min(1).optional(),
  }),
]);

export const UpdateKnowledgeSourceSchema = z.object({
  name: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  syncInterval: z.number().int().min(1).optional(),
  maxDepth: z.number().int().min(1).max(5).optional(),
  maxPages: z.number().int().min(1).optional(),
  enabled: z.boolean().optional(),
});

export const BatchSyncSchema = z.object({
  sourceIds: z.array(z.number().int().positive()).min(1, '必须提供至少一个知识源 ID'),
});

export type CreateKnowledgeSourceInput = z.infer<typeof CreateKnowledgeSourceSchema>;
export type UpdateKnowledgeSourceInput = z.infer<typeof UpdateKnowledgeSourceSchema>;
export type BatchSyncInput = z.infer<typeof BatchSyncSchema>;
