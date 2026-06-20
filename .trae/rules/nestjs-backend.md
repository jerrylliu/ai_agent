# NestJS 后端技术栈规范

> 作用域：`servers/jerry-llm-server/`  
> 关联：本规范在 `global.md` 基础上，针对 NestJS + TypeORM + LangChain 技术栈做细化约束。

---

## 1. 技术栈速查

| 类别 | 技术 | 版本 | 备注 |
|------|------|------|------|
| 框架 | NestJS | 11.x | ESM 模式 |
| 运行时 | Node.js | - | TypeScript 5.9 |
| ORM | TypeORM | 0.3.x | `synchronize: true`（开发阶段） |
| 数据库 | MySQL | - | 通过 mysql2 驱动 |
| 向量数据库 | ChromaDB | - | 通过 chromadb 包访问 |
| 缓存 | Redis | - | ioredis，可选启用 |
| LLM | LangChain | 1.x | @langchain/classic, @langchain/langgraph |
| 日志 | Winston | 3.x | nest-winston + Loki |
| 校验（DTO） | class-validator | 0.15.x | 现有 Controller DTO 主线 |
| 转换 | class-transformer | 0.5.x | 配合 class-validator |
| 校验（zod） | zod | 4.x | 配置 / Tools / structured output / 新接口 |
| 认证 | JWT | - | jsonwebtoken + bcryptjs |
| 实时通信 | WebSocket | - | ws 库，见 speech.gateway |
| 任务调度 | @nestjs/schedule | 6.x | cron/interval 定时任务 |
| 限流 | @nestjs/throttler | 6.x | 配合自定义 RateLimitGuard |
| 测试 | Jest | 30.x | + supertest (E2E) |

---

## 2. NestJS 模块与分层约束

### 2.1 文件组织
```
src/
├── auth/                 # 认证模块（独立 NestJS Module）
│   ├── auth.module.ts
│   ├── auth.service.ts
│   ├── auth.guard.ts     # 认证守卫
│   ├── optional-auth.guard.ts
│   ├── rate-limit.guard.ts
│   └── dto.ts            # 认证相关 DTO
├── controllers/          # HTTP 控制器
│   ├── chat.controller.ts
│   ├── knowledge.controller.ts
│   └── ...
├── services/             # 业务服务层
│   ├── session.service.ts
│   ├── memory.service.ts
│   └── ...
├── entities/             # TypeORM 实体定义
│   ├── user.entity.ts
│   └── ...
├── fundamentals/         # 基础设施（跨模块共享）
│   ├── config.ts         # 统一配置
│   ├── logger.ts         # Winston 日志模块
│   ├── redis-client.ts   # Redis 客户端
│   ├── cache.ts          # 缓存抽象
│   ├── prompt.ts         # Prompt 模板
│   ├── sse-writer.ts     # SSE 流式写入
│   ├── router/           # Agent 路由
│   ├── tools/            # LangChain Tools
│   ├── vector-store/     # 向量存储操作
│   └── workflow/         # 工作流引擎
├── gateways/             # WebSocket 网关
├── app.module.ts         # 根模块
└── main.ts               # 入口文件
```

### 2.2 Controller 约束
- **只做转发**：解析请求参数 → 调用 Service → 返回响应。不得包含业务逻辑。
- 使用 `class-validator` 装饰器校验 DTO，全局已启用 `ValidationPipe({ whitelist: true, transform: true })`。
- SSE 流式响应必须通过 `@Res() res: Response` 手动控制，**不得**使用 `@Sse()` 装饰器（当前项目 SSE 实现方式）。
- 所有 Controller 方法必须有 JSDoc 注释，标注接口功能。
- **必须**使用 `@UseGuards(OptionalAuthGuard)` 获取当前用户身份。

### 2.3 Service 约束
- 通过 `@Injectable()` 声明，构造函数注入依赖。
- 数据库操作通过 `@InjectRepository(Entity)` 注入的 TypeORM Repository 进行。
- Logger 导入方式：`import { logger } from '../fundamentals/logger'`，并携带 `{ module: 'ServiceName' }`。

```typescript
// 正确示例
import { logger } from '../fundamentals/logger';

@Injectable()
export class SessionService {
  async saveChatHistory(sessionId: string, role: string, content: string) {
    logger.debug('保存聊天记录', { module: 'SessionService', sessionId });
    // ... 业务逻辑
  }
}
```

### 2.4 Entity 约束
- TypeORM 实体使用装饰器风格（非 Active Record）。
- 时间字段使用 `@CreateDateColumn()` 和 `@UpdateDateColumn()`。
- 实体类名与文件名一致（PascalCase），表名使用小写下划线命名。

---

## 3. ESM 模块规范（重要）

### 3.1 Import 必须带 `.js` 后缀
- NestJS 11 使用 ESM 模式，**所有相对路径 import 必须带 `.js` 后缀**：
  ```typescript
  // 正确
  import { config } from '../fundamentals/config.js';
  import { User } from '../entities/user.entity.js';
  
  // 错误
  import { config } from '../fundamentals/config';
  ```
- **原因**：你反馈 AI 经常写错 import 路径。这是 NestJS ESM 模式的硬性要求，不加 `.js` 会导致运行时报错 `ERR_MODULE_NOT_FOUND`。

### 3.2 第三方包 import 不带后缀
- `import { Injectable } from '@nestjs/common'` — 正确。
- `import { Injectable } from '@nestjs/common.js'` — 错误。

---

## 4. DTO 与校验规范

### 4.1 DTO 定义
- 每个 Controller 的 POST/PUT/PATCH 接口**必须**有对应的 DTO 类，位置在同文件或 `auth/dto.ts`。
- 使用 `class-validator` 装饰器：`@IsString()`, `@IsOptional()`, `@IsEmail()`, `@IsArray()`, `@MaxLength()` 等。

```typescript
// 正确示例
import { IsString, IsOptional, IsArray } from 'class-validator';

export class PromptDto {
  @IsString()
  message: string;

  @IsOptional()
  @IsArray()
  images?: string[];

  @IsOptional()
  @IsString()
  sessionId?: string;
}
```

### 4.2 校验失败处理
- 全局 `ValidationPipe` 已启用 `whitelist: true`（剥离未声明的属性）和 `transform: true`（自动类型转换）。
- **禁止**在 Controller 中手动写 `if (typeof body.message !== 'string')` 这样的类型检查，应让 DTO 校验处理。

### 4.3 zod 与 class-validator 的边界
本项目同时存在两套校验体系，**按场景分工**，不要混用：

| 场景 | 推荐方案 | 说明 |
|------|----------|------|
| 现有 Controller DTO（已用 class-validator） | 保持 class-validator | 不做存量改造，避免双轨 |
| 新增 Controller / 复杂表单 | 优先 zod + `ZodValidationPipe` | 类型推导更强，schema 可复用 |
| 环境变量 / `config.ts` | **必须** zod | 启动 fail-fast，见 `fundamentals/config.ts` |
| LangChain / MCP Tool 入参 | **必须** zod | 直接被 LLM function calling 消费 |
| LLM 结构化输出（`withStructuredOutput`） | **必须** zod | 防止 LLM 返回非法 JSON 击穿业务 |
| WebSocket / SSE 出站事件 | 推荐 zod | 跨端共享 schema，前后端约定一致 |
| TypeORM Entity | **不要**用 zod 重写 | Entity 已有装饰器强类型，重复定义反而拖累 |

### 4.4 ZodValidationPipe 使用规范
统一使用 [`fundamentals/zod-validation.pipe.ts`](file:///e:/miaoma-ai-app/servers/jerry-llm-server/src/fundamentals/zod-validation.pipe.ts) 提供的 `ZodValidationPipe`：

```typescript
import { z } from 'zod';
import { ZodValidationPipe } from '../fundamentals/zod-validation.pipe.js';

const CreatePostSchema = z.object({
  title: z.string().min(1).max(120),
  tags: z.array(z.string()).default([]),
});
type CreatePostDto = z.infer<typeof CreatePostSchema>;

@Post()
create(
  @Body(new ZodValidationPipe(CreatePostSchema, { label: 'CreatePost' }))
  body: CreatePostDto,
) {
  return this.svc.create(body);
}
```

约束：
- **禁止**为同一接口同时挂载 class-validator DTO 与 zod schema。
- 类型必须用 `z.infer<typeof Schema>` 推导，不得另写 interface 重复声明。
- schema 对象常量命名以 `Schema` 结尾（如 `CreatePostSchema`），便于检索。
- 校验失败统一抛 `BadRequestException`，错误结构详见 Pipe 文件 JSDoc，不要在 Controller 里手动 `safeParse` + 抛错。

---

## 5. TypeORM 使用规范

### 5.1 实体定义
- 使用 `@Entity('table_name')` 指定表名。
- 主键使用 `@PrimaryGeneratedColumn()`。
- 列定义必须指定 `type`，字符串列必须指定 `length`。

### 5.2 查询安全
- **禁止**拼接 SQL 字符串，所有查询必须使用 QueryBuilder 或 Repository 方法。
- 需要原生查询时，使用参数化查询 `query('SELECT * FROM users WHERE id = ?', [id])`。
- **原因**：项目已有用户注册登录，SQL 注入漏洞会导致用户数据泄露。

### 5.3 数据库配置
- 数据库连接配置在 `src/fundamentals/config.ts` 中，通过环境变量注入。
- 开发阶段 `synchronize: true`（自动建表），上线前必须改为 `false` 并使用 Migration。

---

## 6. Redis 使用规范（可选组件）

### 6.1 Redis 启用条件
- 通过环境变量 `REDIS_ENABLED` 控制。当 `REDIS_ENABLED=false` 时，`getRedis()` 返回 `null`，所有 Redis 操作自动降级。
- **必须**在任何 Redis 操作前检查连接状态：
  ```typescript
  const redis = getRedis();
  if (redis) {
    await redis.set(key, value);
  }
  // 如果没有 Redis，代码继续执行而不报错
  ```

### 6.2 Redis 使用场景
- 分布式锁（`fundamentals/distributed-lock.ts`）
- 缓存（`fundamentals/cache.ts`、`multi-level-cache.ts`）
- 限流计数（`auth/rate-limit.guard.ts`）
- **禁止**将 Redis 作为主数据存储（MySQL 是唯一的数据真相源）。

---

## 7. LangChain 与 AI 工具规范

### 7.1 Tool 开发规范
- 所有 LangChain Tool 放在 `fundamentals/tools/` 目录下。
- 每个 Tool 必须有对应的 `.spec.ts` 测试文件。
- Tool 必须包含异常处理，不得让 LangChain 调用崩溃传播到上层。
- **入参必须用 zod 定义并加 `.describe()`**：每个字段的 `.describe()` 文案会作为 LLM function calling 的字段描述，直接影响调用准确率，必填且写中文。
- 当前历史 Tool 同时维护着手写的 OpenAI Function JSON Schema 与 zod schema（如 `manage-session.ts`），新 Tool 应**只维护 zod schema**，由公共转换层产出 JSON Schema，避免双轨漂移。

### 7.2 LLM 结构化输出（structured output）
- **禁止**对 LLM 返回值直接 `JSON.parse`，必须经过 zod 校验。
- 推荐 `model.withStructuredOutput(zodSchema)`：让 LangChain 走 function calling / json mode，自动重试与失败兜底。
- 兜底策略：解析失败时降级为可观察的错误事件（写日志 + SSE 错误事件），**不得**静默 `try/catch` 后返回空对象。

### 7.3 Vector Store 规范
- 向量存储操作集中在 `fundamentals/vector-store/`。
- 嵌入和搜索操作必须处理空结果、超时等边界情况。
- BM25 + 向量检索的混合搜索通过 `multi-hop-search.ts` 实现。

### 7.4 SSE 流式响应
- 使用 `fundamentals/sse-writer.ts` 封装 SSE 写入。
- SSE 事件格式：`data: ${JSON.stringify(event)}\n\n`。
- 流结束标记：`data: [DONE]\n\n`。
- 推荐为出站事件定义 `z.discriminatedUnion('type', [...])`，并在 `sse-writer` 出口处 `parse`，防止前端拿到结构异常的事件。

---

## 8. 认证与安全

### 8.1 认证守卫
- `OptionalAuthGuard`：可选认证，未登录用户使用 `default` userId。
- `AuthGuard`：强制认证，未登录返回 401。
- `RateLimitGuard`：按用户限流（优先级在 OptionalAuthGuard 之后）。
- 新 Controller 默认使用 `@UseGuards(OptionalAuthGuard)`，敏感接口额外加 `AuthGuard`。

### 8.2 密码安全
- 密码使用 `bcryptjs.hash(password, 10)` 加密存储。
- 密码最大长度 128 字符（参见 `auth.service.ts` 中的 `MAX_PASSWORD_LENGTH`）。
- **禁止**在任何日志中打印 `password` 字段。

### 8.3 JWT 处理
- JWT 密钥通过环境变量 `JWT_SECRET` 注入（启动时缺失会拒绝启动）。
- JWT 有效期：7 天。
- Token 版本号 `tokenVersion` 机制（用户实体中），可用于批量使 Token 失效。

---

## 9. 测试规范

### 9.1 单元测试
- 使用 Jest，配置文件在 `package.json` 的 `jest` 字段。
- 测试文件命名：`*.spec.ts`，放在源文件同级目录。
- Service 测试必须 Mock 所有外部依赖（Repository、Redis、Logger）。

### 9.2 E2E 测试
- 使用 `supertest` + Jest 的 E2E 配置（`test/jest-e2e.json`）。
- E2E 测试覆盖核心业务流程：注册 → 登录 → 创建会话 → 发送消息 → 收到 AI 回复。
- **原因**：你提到需要 E2E 测试规范。LLM 场景的 E2E 测试应 Mock 外部 AI API 调用（LangChain），确保测试可重复。

### 9.3 测试覆盖率
- 当前阶段目标：Service 层核心方法覆盖率 > 60%。
- 不追求 UI / Controller 层的覆盖率。

---

## 10. 定时任务规范

### 10.1 Scheduler Service
- `DocumentSchedulerService`、`KnowledgeSourceSchedulerService`、`GeneratedDocumentSchedulerService` 使用 `@nestjs/schedule`。
- 使用 `@Cron()` 或 `@Interval()` 装饰器。
- **禁止**在定时任务中长时间阻塞（超过 30 秒），必要时应拆分为多个小任务或使用队列。

---

## 11. 配置依赖清单（AI 必须知道的依赖名称）

以下为本项目**已安装**的关键依赖，AI 生成代码时只能使用这些包及其提供的 API：

| 用途 | 包名 | 版本 |
|------|------|------|
| HTTP 框架 | `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` | ^11.x |
| ORM | `@nestjs/typeorm`, `typeorm`, `mysql2` | 0.3.x |
| 校验（DTO） | `class-validator`, `class-transformer` | 0.15.x / 0.5.x |
| 校验（schema） | `zod` | ^4.4.x |
| 日志 | `nest-winston`, `winston`, `winston-loki` | - |
| 认证 | `jsonwebtoken`, `bcryptjs` | - |
| 缓存 | `ioredis` | ^5.x |
| 向量库 | `chromadb` | ^3.x |
| LLM | `@langchain/core`、`@langchain/classic`、`@langchain/langgraph` | ^1.x |
| MCP | `@modelcontextprotocol/sdk` | ^1.x |
| WebSocket | `ws` | ^8.x |
| 爬虫 | `puppeteer`, `cheerio` | - |
| 文档处理 | `pdf-parse`, `mammoth`, `docx` | - |
| 邮件 | `nodemailer` | - |

**AI 生成代码时，绝对不能引入上述列表之外的依赖**（除非用户明确要求安装新包）。

---

## 12. Zod 使用总则（统一索引）

zod 在本项目的落地分布如下，新代码必须按此分工执行，已存在的实现不要回退：

| 模块 | 当前状态 | 强制要求 |
|------|----------|----------|
| [`fundamentals/config.ts`](file:///e:/miaoma-ai-app/servers/jerry-llm-server/src/fundamentals/config.ts) | 已 zod 化，启动 fail-fast | 新增配置项必须加入对应 zod schema 字段，不得绕过 |
| [`fundamentals/zod-validation.pipe.ts`](file:///e:/miaoma-ai-app/servers/jerry-llm-server/src/fundamentals/zod-validation.pipe.ts) | 已提供统一 Pipe | 新 Controller 走 zod 时必须使用此 Pipe |
| `fundamentals/tools/*` | 部分用 zod、部分手写 JSON Schema | 新 Tool 仅用 zod；存量改造单独立项 |
| `fundamentals/router/*`、`fundamentals/workflow/*` | 部分裸 `JSON.parse` | 新代码必须 `withStructuredOutput(zodSchema)` |
| `gateways/*`、`fundamentals/sse-writer.ts` | 多为裸对象 | 新事件类型推荐 `z.discriminatedUnion` 并在出口 parse |
| TypeORM `entities/*` | 装饰器强类型 | **不要**叠加 zod |

最佳实践：
- schema 与类型同源：`type Foo = z.infer<typeof FooSchema>`，禁止重复 interface。
- schema 文件命名：与消费方同级，命名 `xxx.schema.ts`，或在同文件内 `// ==================== Zod Schema ====================` 区块。
- 字段必须带 `.describe('中文说明')`：用于 LLM tools / OpenAPI 文档生成。
- 不要 catch zod 错误后吞掉：`safeParse` 失败一律走结构化日志 + 抛业务异常。
