# Aether MC AI App

> AI 驱动的桌面助手应用 | Tauri 2 + React 19 + NestJS 11 + LangChain

---

## 项目简介

Aether MC AI App 是一个基于大语言模型的智能桌面助手，提供对话交互、知识库管理、RAG 检索增强生成、文档生成与管理等能力。采用 pnpm Monorepo 架构，前后端分离。

| 模块 | 路径 | 技术栈 |
|------|------|--------|
| 桌面客户端 | `clients/jerry-ai-app/` | Tauri 2 + React 19 + TailwindCSS 4 + Zustand |
| LLM 后端服务 | `servers/jerry-llm-server/` | NestJS 11 + TypeORM + LangChain + Redis |

---

## 快速开始

### 环境要求

- Node.js >= 18
- pnpm >= 8
- MySQL 8.0+
- ChromaDB（向量数据库）
- Rust（Tauri 编译需要）

### 安装与运行

```bash
# 1. 安装所有依赖
pnpm install

# 2. 配置环境变量
cp servers/jerry-llm-server/.env.example servers/jerry-llm-server/.env
# 编辑 .env 文件，填写数据库密码、JWT_SECRET 等

# 3. 启动后端服务
pnpm --filter jerry-llm-server start:dev

# 4. 启动桌面客户端
pnpm --filter jerry-ai-app tauri dev
```

---

## AI 协作指引 (Trae IDE)

### 工程规范文件

本项目已配置 Trae IDE 的 AI 协作规范，AI 在生成代码时会自动读取以下规则文件：

| 文件 | 说明 | 加载时机 |
|------|------|---------|
| `.trae/rules/global.md` | 全局工程规范（依赖、分层、类型、安全） | 始终加载 |
| `.trae/rules/nestjs-backend.md` | NestJS 后端技术栈规范 | 编辑 `servers/` 下文件时 |
| `.trae/rules/react-frontend.md` | React 前端技术栈规范 | 编辑 `clients/` 下文件时 |

### 需求规格模板

在进行功能开发前，建议先创建 Spec 文档：

```
.trae/specs/_template.md   → 复制重命名为 .trae/specs/[feature-name].md
```

填写完 Spec 后，将其作为上下文提供给 AI，可获得更精准的代码生成。

### 给 AI 协作者的提示

1. **导入新依赖前**，先检查对应子项目的 `package.json`，确认包是否已安装。
2. **后端 import 必须带 `.js` 后缀**（NestJS ESM 模式）。
3. **前端 import 使用 `@/` 别名**，不使用相对路径。
4. **严格遵循分层架构**：Controller → Service → Entity（后端），Page → Component → Hook → Store → API（前端）。
5. **只修改与需求直接相关的代码**，不要顺手重构。

### 项目文档索引

| 文档 | 内容 |
|------|------|
| `CODING_WIKI.md` | 项目架构、模块说明、数据库设计 |
| `servers/jerry-llm-server/docs/REDIS_INFRASTRUCTURE.md` | Redis 基础设施说明 |
| `servers/jerry-llm-server/docs/document-version-management-plan.md` | 文档版本管理设计 |
| `servers/jerry-llm-server/TEST_REPORT.md` | 后端测试报告 |

---

## 代码质量工具

### 已配置的 Linter / Formatter

| 工具 | 配置文件 | 适用范围 | 运行命令 |
|------|---------|---------|---------|
| **ESLint** | `eslint.config.js`（根, flat config） | 全局 JS/TS | `pnpm lint` |
| **ESLint** | `servers/jerry-llm-server/eslint.config.mjs` | NestJS 后端 | `pnpm --filter jerry-llm-server lint` |
| **Prettier** | `.prettierrc`（根） | 全局代码格式化 | `pnpm --filter jerry-llm-server format` |
| **CSpell** | `cspell.json`（根） | 拼写检查 | `npx cspell "**/*.ts"` |
| **Commitlint** | `commitlint.config.js`（根） | Git 提交信息校验 | 提交时自动触发 |
| **EditorConfig** | `.editorconfig`（根） | 编辑器基础配置 | IDE 自动加载 |
| **TypeScript** | `tsconfig.json`（各子项目） | 类型检查 | `pnpm --filter jerry-ai-app build` |

### 推荐安装命令

如果你在新环境初始化项目，确保安装以下工具：

```bash
# 全局工具（可选，CI/CD 时会自动使用项目本地版本）
pnpm add -g prettier eslint commitlint

# 项目已配置完整的 lint-staged（如需添加）
pnpm --filter jerry-llm-server add -D lint-staged husky
```

### VS Code 推荐插件

```
- ESLint (dbaeumer.vscode-eslint)
- Prettier (esbenp.prettier-vscode)
- Tailwind CSS IntelliSense (bradlc.vscode-tailwindcss)
- Rust Analyzer (rust-lang.rust-analyzer)  — Tauri 开发需要
- Tauri (tauri-apps.tauri-vscode)
- Code Spell Checker (streetsidesoftware.code-spell-checker)
```

### Git Hooks（可选增强）

当前项目已配置 `commitlint`，建议扩展：

```bash
# 安装 husky + lint-staged
pnpm add -Dw husky lint-staged
pnpm exec husky init

# 在 .husky/pre-commit 中添加：
# pnpm lint-staged

# 在 package.json 中添加：
# "lint-staged": {
#   "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
#   "*.{json,md,css}": ["prettier --write"]
# }
```

---

## Git 提交规范

使用 Conventional Commits 格式：

```
feat(scope): 功能描述
fix(scope): 修复描述
chore(scope): 杂项描述
```

scope 取值：`client`（前端）、`server`（后端）、`tauri`（Rust）、`root`（根配置）。

---

## 许可证

UNLICENSED - 个人项目，未开放许可。
