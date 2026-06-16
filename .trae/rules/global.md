# 全局工程规范

> 本文件适用于整个 Monorepo 的所有子项目。子项目特有的规范见同目录下的技术栈规则文件。

---

## 1. 依赖管理（最高优先级）

### 1.1 禁止凭空引入依赖
- **禁止**引入 `package.json` 中不存在的包。如果需要新依赖，必须明确提示用户执行 `pnpm add <pkg>`。
- **禁止**使用过时或不存在于该版本中的 API。例如：NestJS 11 中 `@nestjs/common` 的某些装饰器与 NestJS 8 不同，必须参考**本项目实际安装版本**的 API。
- **原因**：你反馈这是最头疼的问题。Monorepo 中不同子项目有独立的 `package.json`，AI 容易交错引入不同子项目的依赖，导致编译失败。

### 1.2 Monorepo 包引用规则
- 子项目之间**不直接通过 `workspace:*` 引用**，各自独立。不要凭空创建跨项目的 import。
- 根目录 `pnpm-workspace.yaml` 定义了 `clients/*`、`servers/*`、`frontend/*` 三个工作区，安装依赖时需指定 `--filter`：`pnpm --filter jerry-llm-server add <pkg>`。

### 1.3 包管理器
- 统一使用 **pnpm**，禁止使用 npm 或 yarn 命令。
- 锁文件为 `pnpm-lock.yaml`，禁止生成 `package-lock.json` 或 `yarn.lock`。

---

## 2. 代码结构与分层

### 2.1 后端分层（NestJS）
```
Controller（路由 & 参数校验，只做转发）
  ↓ 调用
Service（业务逻辑，不含 HTTP 概念）
  ↓ 操作
Entity / Repository（数据持久化）
```
- **禁止** Controller 直接操作 Repository 或包含业务逻辑。
- **禁止** Service 直接访问 `@Req()` / `@Res()` 等 HTTP 层对象。
- **原因**：你反馈 AI 经常跨层调用。分层混乱会导致后期重构困难，尤其是一个人维护时要确保代码可预测。

### 2.2 前端分层（React）
```
Page（页面组装 & 路由级状态）
  ↓ 使用
Component（纯 UI 组件，通过 props 通信）
  ↓ 调用
Hook（逻辑复用 & API 调用）
  ↓ 使用
Store（Zustand，全局/持久化状态）
  ↓ 调用
API Client（`src/lib/api.ts`，HTTP 请求封装）
```
- **禁止** 在 Component 中直接调用 fetch/API 端点。
- **禁止** 在 Store 中引入 React 概念（如 hooks、组件）。
- **原因**：前端已有 `lib/api.ts` + Zustand stores 的分层基础，AI 必须延续这一模式，避免 API 调用散落各处。

---

## 3. TypeScript 类型规范

### 3.1 类型安全
- **禁止**使用 `any`，除非有充分理由并在上方用 `// eslint-disable-next-line @typescript-eslint/no-explicit-any` 注释说明。
- **禁止**使用 `// @ts-ignore`，应使用 `// @ts-expect-error`（表示已知错误并期望 TypeScript 报告）。
- 所有新函数必须声明**完整的参数类型和返回类型**，不得依赖类型推断隐式省略。
- **原因**：你反馈 AI 生成的代码缺少类型校验。本项目的 `tsconfig.json` 已开启 `strict: true`，类型缺失会直接报错。

### 3.2 类型定义
- 共享类型放在 `types/` 目录下。
- 与后端接口交互的 DTO 类型必须在 `types/` 中定义，禁止在组件/Service 中内联 `{ name: string }` 这样的匿名类型。

### 3.3 Import 路径
- 前端统一使用 `@/` 别名（对应 `src/`），不使用相对路径 `../../`。
- 后端使用**相对路径带 `.js` 后缀**（NestJS ESM 模式要求，如 `import { config } from '../fundamentals/config.js'`）。

---

## 4. 配置与密钥管理

### 4.1 环境变量
- 所有配置通过环境变量注入，后端统一在 `src/fundamentals/config.ts` 中管理，前端通过 `.env` 文件 + Vite 的 `import.meta.env`。
- **禁止**在代码中硬编码任何密钥、Token、数据库密码。
- **禁止**将 `.env` 文件提交到版本控制（已通过 `.gitignore` 排除）。
- 新增配置项时，必须同步更新 `.env.example` 并附上说明。
- **原因**：项目已从个人使用向多用户进化，敏感数据泄露风险必须从编码阶段杜绝。

### 4.2 敏感数据
- 明文密码**绝不**写入日志、不在客户端存储。
- 前端 localStorage 中的 JWT Token 使用固定 key `miaoma_auth_token`（已在 `lib/api.ts` 中定义）。
- 用户实体的 `password` 字段使用 bcryptjs 加密存储，注册/登录逻辑不得直接操作明文。

---

## 5. 日志规范

### 5.1 后端日志
- 统一使用 Winston（通过 `nest-winston` 注入或 `import { logger } from '../fundamentals/logger'`）。
- **禁止**使用 `console.log` / `console.error`（生产环境无结构化输出）。
- 日志必须携带 `module` 字段，格式：`logger.info('消息描述', { module: 'ServiceName', ... })`。
- 错误日志使用 `logger.error('消息', { module: 'xxx', error: err.message, stack: err.stack })`。
- **原因**：项目已集成 Winston + Loki 做结构化日志，`console.log` 会绕过这套体系，导致日志无法被 Loki 采集。

### 5.2 前端日志
- 开发阶段可使用 `console.warn` / `console.error`，但生产构建时会移除。关键错误必须通过 UI（Toast/ErrorBoundary）反馈给用户。

---

## 6. Git 提交规范

### 6.1 Commit Message
- 使用 Conventional Commits 格式（已配置 `commitlint.config.js`）：
  ```
  feat(scope): 描述
  fix(scope): 描述
  chore(scope): 描述
  docs(scope): 描述
  test(scope): 描述
  ```
- scope 可选值：`client`（前端）、`server`（后端）、`tauri`（Rust端）、`root`（根配置）。
- **原因**：一个人维护时期，规范的 commit message 是你回顾代码变更的唯一文档。

### 6.2 代码格式
- 提交前确保通过 `pnpm lint` 和 `prettier --check`。
- Prettier 配置（根目录 `.prettierrc`）：`singleQuote: true, trailingComma: 'all'`。

---

## 7. 文档与注释

### 7.1 注释规范
- 复杂业务逻辑**必须**写中文注释，说明"为什么这样做"而不是"做了什么"。
- 对外暴露的 API（模块导出、Controller 路由、Service 公共方法）必须添加 JSDoc 注释。
- 已在项目中出现的中文注释风格要保持一致（如 Controller 中的 `// ==================== 区块名 ====================`）。

### 7.2 禁止的行为
- **禁止** 删除或重写现有注释而不理解其含义。
- **禁止** 在不确定时用英文注释替换已有的中文注释。
- **原因**：你目前一个人维护，中文注释能降低认知负担。未来团队扩展时也便于新人理解。

---

## 8. 代码修改原则

### 8.1 最小改动
- 只修改与需求直接相关的代码，不要顺手重构无关代码。
- 不要添加未被明确要求的"优化"或"额外功能"。
- **原因**：个人开发阶段，过度重构会增加不可预知的 Bug 风险。

### 8.2 改动前必读
- 修改任何文件前，必须先阅读该文件及其直接依赖的文件。
- 修改公共模块（如 `fundamentals/`、`lib/api.ts`、`types/`）时，必须检查所有引用点。

### 8.3 删除代码
- 删除变量/函数前，必须用 Grep 搜索项目中所有引用点，确认无引用后才可删除。
- **原因**：你一个人维护整个项目，IDE 的"查找引用"不一定能覆盖所有文件。

---

## 9. 测试规范

### 9.1 测试文件位置
- 前端测试文件与源文件同级，命名 `*.test.ts` / `*.test.tsx`。
- 后端测试文件与源文件同级，命名 `*.spec.ts`。
- 前端测试 setup 文件：`src/test/setup.ts`。

### 9.2 AI 生成测试的原则
- 修改 Service/Controller/Hook 的核心逻辑时，**必须**同步更新对应的测试文件。
- 新增功能时，如果涉及复杂业务逻辑（条件分支 > 3），**按需**生成测试。
- 纯 UI 组件（如简单展示组件）不要求必须写测试。
- **原因**：你目前是个人开发，全量 TDD 成本过高，但核心逻辑必须有测试保护，防止回归。

---

## 10. 知识库与文档索引

当遇到以下场景时，AI 应主动读取相关文档：
- **Redis 基础设施** → `servers/jerry-llm-server/docs/REDIS_INFRASTRUCTURE.md`
- **文档版本管理** → `servers/jerry-llm-server/docs/document-version-management-plan.md`
- **项目编码规范** → `CODING_WIKI.md`
- **测试报告** → `servers/jerry-llm-server/TEST_REPORT.md`
