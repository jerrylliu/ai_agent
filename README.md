# Aether MC AI App（以太忆核）

> AI 驱动的桌面助手应用 | Tauri 2 + React 19 + NestJS 11 + LangChain 1.x + Tiptap 3

---

## 项目简介

Aether MC AI App 是一个基于大语言模型的智能桌面助手，提供流式对话、Agent 工具编排、RAG 知识库、文档版本管理、AI 写作编辑器、飞书集成、语音交互等能力。采用 pnpm Monorepo 架构，前后端分离。

### 核心能力

| 能力域 | 说明 |
|--------|------|
| **智能对话** | SSE 流式问答、多轮对话、Function Calling Agent、5 角色 Agent 路由（通用/搜索/分析/创作/文档）、Plan-Execute 计划执行、Human-in-the-Loop 工具确认、用户记忆与会话摘要 |
| **RAG 知识库** | 多格式文档解析（MinerU / pdfjs / Word / Excel）、多模态图片入库（VLM 视觉翻译 + 降级链 + 定时重试）、混合检索（向量 + BM25 RRF 融合）、Query Rewriting、Multi-hop 多跳检索、Reranker 重排、语义缓存 |
| **文档版本管理** | 版本时间线、回滚、Diff 对比、审计日志、注入扫描发布门禁（静态签名 + LLM 语义判定 + 人工复核）、向量化失败补偿机制、定时维护任务 |
| **AI 写作编辑器** | Tiptap 3 富文本编辑器、AI 幽灵补全（Tab 接受）、选区改写（润色/翻译/续写）、全文 AI 指令、知识库检索引用面板、Tauri 多窗口编辑、一键发布到知识库 |
| **Agent 工具集** | 22 个工具（17 常驻 + 5 条件注册）：知识库搜索/清单、联网搜索、网页抓取、天气、计算、NL2SQL、会话管理、Plan-Execute、文档增删改查/摘要/对比、图表生成、文生图、思维导图、PDF/Word/HTML/MD 文档生成、飞书/邮件/Webhook 通知、工作流、MCP Proxy |
| **工作流引擎** | 声明式顺序流水线、步骤间数据绑定、4 个预置模板（知识库搜索→图表、联网搜索→文档等） |
| **知识源同步** | Web 网页 / 飞书文档知识源接入，定时 + 手动同步、同步日志、更新确认、入库前注入扫描 |
| **飞书集成** | 飞书机器人对话（WebSocket 长连接 / HTTP 回调）、桌面端与飞书会话实时双向同步、生成文档投递为飞书原生文件、HITL 审批卡片推送 |
| **语音交互** | 火山引擎流式 ASR（WebSocket + AudioWorklet PCM 采集 + VAD）、长音频异步转写、浏览器原生 SpeechRecognition 兜底 |
| **安全防护** | Prompt 注入三级检测（blocked / suspicious / safe）、不可信上下文隔离指令、NL2SQL 仅 SELECT + 表白名单、JWT + tokenVersion 批量失效、bcrypt 密码加密、用户限流 |
| **多模型支持** | Ollama 本地模型、DeepSeek / 智谱 / DashScope API，运行时切换、模型能力探测与协商、API Key 加密存储 |
| **可观测与评估** | Prometheus 指标（`/api/metrics`）、Winston + Loki 结构化日志、LLM 用量统计、人工反馈 + 自动评估、工具调用指标、搜索反馈与低满意度查询分析 |
| **基础设施** | Redis 多级缓存（L1 内存 + L2 Redis，可降级）、语义缓存、分布式锁、滑动窗口限流、SSE 标准化协议、事件总线、优雅关闭 |
| **用户体系** | 注册/登录（邮箱或手机号）、密码重置、头像上传、资料管理 |

### 技术栈

| 模块 | 路径 | 技术栈 |
|------|------|--------|
| 桌面客户端 | `clients/jerry-ai-app/` | Tauri 2 + React 19 + TypeScript 5.9 + TailwindCSS 4 + shadcn/ui + Zustand 5 + Tiptap 3 |
| LLM 后端服务 | `servers/jerry-llm-server/` | NestJS 11（ESM）+ TypeORM + MySQL 8 + LangChain 1.x + ChromaDB + Redis（可选）+ zod 4 |

---

## 项目结构

```
miaoma-ai-app/
├── clients/jerry-ai-app/          # Tauri 桌面客户端（以太忆核）
│   ├── src/                       # React 前端（pages / components / hooks / stores / lib / types）
│   └── src-tauri/                 # Rust 端（多窗口、文件对话框）
├── servers/jerry-llm-server/      # NestJS LLM 后端
│   ├── src/auth/                  # 认证模块（JWT、守卫、限流）
│   ├── src/controllers/           # HTTP 控制器（13+）
│   ├── src/services/              # 业务服务（16+）
│   ├── src/entities/              # TypeORM 实体（20 张表）
│   ├── src/fundamentals/          # 基础设施（Agent 路由 / 工具集 / 向量库 / 工作流 / 缓存 / 飞书 / 语音等）
│   ├── src/migrations/            # TypeORM 迁移
│   ├── scripts/                   # 运维与评估脚本（模型探测、RAG 评估、chunk 去重清理）
│   └── docker/                    # 开发依赖编排 + Prometheus/Grafana/Loki 监控配置
├── .trae/rules/                   # AI 协作规范（全局 / 后端 / 前端）
├── interview/                     # 面试备战资料
└── pnpm-workspace.yaml            # 工作区：clients/* 、servers/* 、frontend/*
```

---

## 快速开始

### 环境要求

- Node.js >= 18（推荐 20+）
- pnpm >= 8
- MySQL 8.0+
- ChromaDB（向量数据库）
- Rust（Tauri 桌面端编译需要）
- 可选：Redis 7（未启用时后端自动降级为内存模式）、Ollama（本地模型）、Docker

### 一键拉起依赖服务（Docker）

MySQL / Redis / ChromaDB / Ollama 可通过 Docker Compose 一键启动：

```bash
cd servers/jerry-llm-server/docker

# 全量启动
docker compose -f docker-compose.dev.yml up -d

# 或按需启动（本地已装的服务跳过）
docker compose -f docker-compose.dev.yml up -d redis chroma
```

### 安装与运行

```bash
# 1. 安装所有依赖
pnpm install

# 2. 配置环境变量
cp servers/jerry-llm-server/.env.example servers/jerry-llm-server/.env
# 编辑 .env：数据库密码、JWT_SECRET 等（可选：搜索/天气/飞书/火山 ASR/MinerU/VLM 等集成）

# 3. 启动后端服务（默认端口 3000）
pnpm --filter jerry-llm-server start:dev

# 4. 启动桌面客户端（Vite 开发端口 1420）
pnpm --filter jerry-ai-app tauri dev
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm --filter jerry-llm-server start:dev` | 启动后端（watch 模式） |
| `pnpm --filter jerry-llm-server test` | 后端单元测试（Jest） |
| `pnpm --filter jerry-llm-server test:e2e` | 后端 E2E 测试（supertest） |
| `pnpm --filter jerry-llm-server migration:run` | 执行数据库迁移 |
| `pnpm --filter jerry-llm-server probe` | 模型能力探测 |
| `pnpm --filter jerry-llm-server eval:run` | RAG / Agent 评估脚本 |
| `pnpm --filter jerry-ai-app tauri dev` | 启动桌面客户端开发环境 |
| `pnpm --filter jerry-ai-app test` | 前端单元测试（Vitest） |
| `pnpm lint` | 全局 ESLint 检查 |

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
| `项目技术架构与分析文档.md` | 项目整体架构设计、AI 管道深度解析、API 接口矩阵、数据模型、AI 写作编辑器架构 |
| `CODING_WIKI.md` | 项目架构、模块说明、数据库设计 |
| `以太忆核新人阅读指南.md` | 新人上手阅读路线 |
| `MONITORING.md` | Prometheus + Grafana + Loki 监控体系说明 |
| `servers/jerry-llm-server/docs/REDIS_INFRASTRUCTURE.md` | Redis 基础设施说明 |
| `servers/jerry-llm-server/docs/document-version-management-plan.md` | 文档版本管理设计 |
| `servers/jerry-llm-server/docs/多模态入库方案-v2.md` | 多模态（图片）入库方案 |
| `servers/jerry-llm-server/TEST_REPORT.md` | 后端测试报告 |
| `interview/` | 面试备战资料（问答清单、技术深度故事、项目讲解脚本） |

---

## 代码质量工具

| 工具 | 配置文件 | 适用范围 | 运行命令 |
|------|---------|---------|---------|
| **ESLint** | `eslint.config.js`（根, flat config） | 全局 JS/TS | `pnpm lint` |
| **ESLint** | `servers/jerry-llm-server/eslint.config.mjs` | NestJS 后端 | `pnpm --filter jerry-llm-server lint` |
| **Prettier** | `.prettierrc`（根） | 全局代码格式化 | `pnpm --filter jerry-llm-server format` |
| **CSpell** | `cspell.json`（根） | 拼写检查 | `npx cspell "**/*.ts"` |
| **Commitlint** | `commitlint.config.js`（根） | Git 提交信息校验 | 提交时自动触发 |
| **EditorConfig** | `.editorconfig`（根） | 编辑器基础配置 | IDE 自动加载 |
| **TypeScript** | `tsconfig.json`（各子项目） | 类型检查 | `pnpm --filter jerry-ai-app build` |

### VS Code 推荐插件

```
- ESLint (dbaeumer.vscode-eslint)
- Prettier (esbenp.prettier-vscode)
- Tailwind CSS IntelliSense (bradlc.vscode-tailwindcss)
- Tiptap (tiptap.tiptap-vscode)  — 富文本编辑器开发需要
- Rust Analyzer (rust-lang.rust-analyzer)  — Tauri 开发需要
- Tauri (tauri-apps.tauri-vscode)
- Code Spell Checker (streetsidesoftware.code-spell-checker)
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
