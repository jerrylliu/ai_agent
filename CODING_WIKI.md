# Miaoma AI App - Code Wiki (第二代)

> 生成日期: 2026-05-24  
> 版本: 2.0  
> 视角: 高级架构师 / 高级产品经理 / AI全栈开发者

---

## 目录

1. [项目概览](#1-项目概览)
2. [整体架构](#2-整体架构)
3. [技术栈总览](#3-技术栈总览)
4. [项目运行方式](#4-项目运行方式)
5. [前端客户端模块](#5-前端客户端模块)
6. [后端服务端模块](#6-后端服务端模块)
7. [数据库设计](#7-数据库设计)
8. [RAG 知识库系统](#8-rag-知识库系统)
9. [对话摘要与长期记忆系统](#9-对话摘要与长期记忆系统)
10. [LLM 模型管理层](#10-llm-模型管理层)
11. [用户认证系统](#11-用户认证系统)
12. [依赖关系图](#12-依赖关系图)
13. [项目缺陷与改进方案](#13-项目缺陷与改进方案)
14. [面向企业级应用的扩展方案](#14-面向企业级应用的扩展方案)

---

## 1. 项目概览

### 1.1 项目定位

Miaoma AI App 是一款 **AI 以太忆核桌面应用**，基于 Tauri 2.0 构建跨平台桌面客户端，后端使用 NestJS 提供 LLM 调用、RAG 知识库、对话摘要、用户记忆等 AI 增强能力。

### 1.2 核心价值主张

| 价值维度 | 说明 |
|---------|------|
| **多模型切换** | 支持本地 Ollama 模型和线上 DeepSeek 模型无缝切换 |
| **RAG 知识库** | 支持上传 TXT/PDF/Word 文档，使用 ChromaDB + BM25 混合检索 |
| **对话摘要** | 长对话自动压缩摘要，解决上下文窗口限制 |
| **长期记忆** | 从对话中提取用户画像（偏好/事实/决策），跨会话持久化 |
| **多模态** | 支持图片上传（视觉模型），Markdown 渲染 |
| **主题系统** | 白天/黑夜/赛博朋克三种主题 |
| **用户认证** | 注册/登录/头像/密码管理 |

### 1.3 项目目录结构

```
miaoma-ai-app/
├── clients/miaoma-ai-app/          # Tauri 桌面客户端 (React + TypeScript)
│   ├── src/
│   │   ├── components/              # UI 组件 (Chat, Sidebar, AuthDialog 等)
│   │   ├── hooks/                   # 自定义 Hooks (useChat, useAuth, useTheme)
│   │   ├── lib/                     # 工具层 (api.ts, constants.ts, utils.ts)
│   │   ├── pages/                   # 页面组件 (ChatAgent.tsx - 核心页面)
│   │   ├── types/                   # TypeScript 类型定义
│   │   └── ...
│   └── src-tauri/                   # Tauri Rust 原生层
│       ├── src/                     # Rust 命令 (commands.rs, lib.rs, main.rs)
│       └── tauri.conf.json          # Tauri 配置
│
├── servers/jerry-llm-server/       # NestJS 后端服务
│   ├── src/
│   │   ├── auth/                    # 认证模块 (Controller, Service, Guard)
│   │   ├── entities/                # TypeORM 实体 (User, Session, ChatHistory 等)
│   │   ├── fundamentals/            # AI 核心能力 (RAG, Prompt, Model, Memory, Summary)
│   │   ├── app.controller.ts        # 主控制器 (所有 API 路由)
│   │   ├── app.service.ts           # 主服务 (业务逻辑编排)
│   │   └── main.ts                  # 应用入口
│   └── ...
│
├── frontend/miaoma-ai-app/          # 前端 Web 包 (占位)
├── servers/miaoma-ai-app/           # 服务端 Web 包 (占位)
└── pnpm-workspace.yaml              # pnpm monorepo 配置
```

---

## 2. 整体架构

### 2.1 架构概览图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        用户 (桌面客户端)                              │
├─────────────────────────────────────────────────────────────────────┤
│  Tauri 2.0 容器                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    React 19 SPA 前端                           │  │
│  │  ┌────────────┐  ┌──────────────┐  ┌────────────────────┐     │  │
│  │  │  左侧边栏   │  │  中间聊天区   │  │   右侧模型面板      │     │  │
│  │  │ SessionList│  │  ChatAgent   │  │   ModelSelector    │     │  │
│  │  │ UserProfile│  │  Markdown    │  │   ApiKeyConfig     │     │  │
│  │  │ Sidebar    │  │  Renderer    │  │                    │     │  │
│  │  └─────┬──────┘  └──────┬───────┘  └────────────────────┘     │  │
│  │        │                │                                      │  │
│  │  ┌─────┴────────────────┴──────────────────────────────┐      │  │
│  │  │                    Hooks 层                          │      │  │
│  │  │  useChat (会话/消息/知识库/模型)                      │      │  │
│  │  │  useAuth (登录/注册/头像)                              │      │  │
│  │  │  useTheme (主题管理)                                  │      │  │
│  │  └──────────────────────┬──────────────────────────────┘      │  │
│  │                         │                                     │  │
│  │  ┌──────────────────────┴──────────────────────────────┐      │  │
│  │  │                  API 客户端层 (lib/api.ts)            │      │  │
│  │  │  fetch → http://localhost:3000/*                     │      │  │
│  │  └──────────────────────┬──────────────────────────────┘      │  │
│  └─────────────────────────┼─────────────────────────────────────┘  │
└────────────────────────────┼─────────────────────────────────────────┘
                             │ HTTP / SSE
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    NestJS 后端 (端口 3000)                           │
│  ┌────────────────────┐  ┌───────────────────────┐                 │
│  │   AppController    │  │    AuthController      │                 │
│  │  /prompt (SSE)     │  │  /auth/register        │                 │
│  │  /sessions/*       │  │  /auth/login           │                 │
│  │  /knowledge/*      │  │  /auth/profile         │                 │
│  │  /models/*         │  │  /auth/avatar          │                 │
│  │  /upload           │  │  /auth/verify          │                 │
│  │  /memories/*       │  │  /auth/password        │                 │
│  └────────┬───────────┘  └───────────┬───────────┘                 │
│           │                          │                              │
│  ┌────────┴──────────────────────────┴───────────┐                 │
│  │                 AppService / AuthService       │                 │
│  │  业务逻辑编排                                   │                 │
│  └────┬──────────────┬──────────────┬────────────┘                 │
│       │              │              │                               │
│  ┌────┴─────┐  ┌─────┴──────┐  ┌───┴──────────┐                   │
│  │fundamentals│  │  TypeORM   │  │  文件系统     │                   │
│  │ prompt.ts  │  │  Repos     │  │  uploads/    │                   │
│  │ rag-       │  │  Entities  │  │  files/*     │                   │
│  │ service.ts │  │            │  │              │                   │
│  │ vector-    │  │            │  │              │                   │
│  │ store.ts   │  │            │  │              │                   │
│  │ model-     │  │            │  │              │                   │
│  │ provider.ts│  │            │  │              │                   │
│  │ summarizer │  │            │  │              │                   │
│  │ memory-    │  │            │  │              │                   │
│  │ extractor  │  │            │  │              │                   │
│  │ document-  │  │            │  │              │                   │
│  │ parser.ts  │  │            │  │              │                   │
│  └────────────┘  └────────────┘  └──────────────┘                   │
└─────────────────────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
┌──────────────────┐    ┌──────────────────────┐
│   MySQL 8.x      │    │   ChromaDB (向量库)    │
│   (会话/用户/     │    │   :8000              │
│    摘要/记忆)      │    │                      │
└──────────────────┘    └──────────────────────┘
                                │
         ┌──────────────────────┘
         ▼
┌──────────────────┐
│   Ollama         │
│   :11434         │
│   (bge-m3        │
│    embedding,    │
│    LLM 推理)      │
└──────────────────┘
```

### 2.2 请求生命周期（典型对话流程）

```
1. 用户输入文本 → 前端 handleSend()
2. useChat.sendMessage() → saveChatHistory() 保存用户消息到 MySQL
3. getAIResponse() → POST /prompt (SSE 流式请求)
4. AppController.prompt() → AppService.prompt()
5. 获取会话摘要 (SessionSummary) → 获取用户记忆 (UserMemory)
6. RAG 检索 (ChromaDB + BM25 混合搜索) → 获取相关文档
7. 构建 System Prompt (含知识库/摘要/记忆注入)
8. 构建消息列表 (历史 + 当前用户消息)
9. createLLM() → 根据当前模型配置创建 LLM 实例
10. llm.stream() → SSE 逐 chunk 推送给前端
11. 前端 ReadableStream 逐块渲染 → 保存助手消息到 MySQL
12. 异步触发: 检查是否需要更新摘要 / 提取用户记忆
```

---

## 3. 技术栈总览

### 3.1 前端 (Client)

| 层级 | 技术 | 版本 |
|------|------|------|
| 桌面容器 | Tauri 2.0 | ^2.10.1 |
| UI 框架 | React | ^19.2.5 |
| 构建工具 | Vite | ^8.0.8 |
| 类型系统 | TypeScript | ~6.0.2 |
| 样式 | Tailwind CSS v4 | ^4.2.2 |
| 组件库 | shadcn/ui (Radix UI) | 自定义 |
| 图标 | Lucide React | ^1.8.0 |
| Markdown | react-markdown + remark-gfm | ^10.1.0 / ^4.0.1 |
| 代码高亮 | react-syntax-highlighter | ^16.1.1 |

### 3.2 后端 (Server)

| 层级 | 技术 | 版本 |
|------|------|------|
| 框架 | NestJS | ^11.1.18 |
| ORM | TypeORM + MySQL | ^0.3.28 / ^3.21.0 |
| LLM SDK | LangChain (OpenAI/Ollama) | @langchain/* |
| 向量库 | ChromaDB | ^3.4.3 |
| Embedding | bge-m3（本地 Ollama / 云端可切换） | @langchain/ollama |
| BM25 检索 | MiniSearch | ^7.2.0 |
| 文本分割 | @langchain/textsplitters | ^1.0.1 |
| 文档解析 | pdf-parse, mammoth | ^1.1.1 / ^1.12.0 |
| 认证 | JWT + bcryptjs | ^9.0.3 / ^3.0.3 |

### 3.3 外部依赖服务

| 服务 | 端口 | 用途 |
|------|------|------|
| MySQL | 3306 | 关系型数据存储 |
| ChromaDB | 8000 | 向量存储与相似性搜索 |
| Ollama | 11434 | 本地 LLM 推理 + Embedding |
| DeepSeek API | https | 线上 LLM (需 API Key) |

---

## 4. 项目运行方式

### 4.1 前置条件

```
- Node.js >= 20
- pnpm
- MySQL 8.x (运行中, root/123456)
- Ollama (运行中, 已安装 bge-m3 embedding 模型 + LLM 模型)
- ChromaDB (运行中, localhost:8000)
- Rust (Tauri 桌面编译需要)
```

### 4.2 启动后端

```bash
cd servers/jerry-llm-server
pnpm install
pnpm start:dev
# 后端服务启动在 http://localhost:3000
```

### 4.3 启动前端 (Web 开发模式)

```bash
cd clients/miaoma-ai-app
pnpm install
pnpm dev
# Vite 开发服务器启动在 http://localhost:1420
```

### 4.4 启动 Tauri 桌面应用

```bash
cd clients/miaoma-ai-app
pnpm tauri dev
# Tauri 桌面窗口启动 (标题: 以太忆核)
```

### 4.5 构建生产版本

```bash
# 后端
cd servers/jerry-llm-server
pnpm build
pnpm start:prod

# 前端桌面应用
cd clients/miaoma-ai-app
pnpm tauri build
```

---

## 5. 前端客户端模块

### 5.1 组件架构

```
App.tsx
 └── ChatAgent.tsx (核心页面 - 1400行)
      ├── SidebarHeader (侧边栏头部: 标题/主题/新建/搜索)
      ├── SessionList (会话列表: 历史/最近问题/会话卡片)
      ├── UserProfile (用户信息: 头像/主题切换/登录/登出)
      ├── HeaderContent (聊天头部: AI信息/知识库状态/上传)
      ├── MemorySummaryDialog (记忆摘要弹窗)
      ├── AuthDialog (登录/注册弹窗)
      └── MarkdownRenderer (Markdown 渲染)
```

### 5.2 核心 Hooks

| Hook | 职责 | 导出方法 |
|------|------|---------|
| `useChat` | 聊天核心业务逻辑 | sessions, messages, sendMessage, sendFile, switchSession, deleteSession, createNewSession, uploadToKnowledgeBase, switchModel, configureApiKey, stopGeneration, 等 20+ 方法 |
| `useAuth` | 用户认证 | login, register, logout, uploadAvatar, updateProfile, changePassword, refreshProfile |
| `useTheme` | 主题管理 | theme (light/dark/cyberpunk), cycleTheme |

### 5.3 关键 API 客户端 ([lib/api.ts](file:///e:/miaoma-ai-app/clients/miaoma-ai-app/src/lib/api.ts))

- **流式 AI 响应**: `getAIResponse()` - 通过 SSE 获取流式 AI 回复，内置 RAG 元数据解析
- **会话管理**: `getSessions()`, `createSession()`, `deleteSession()`, `updateSessionTitle()`, `toggleSessionPin()`
- **消息管理**: `saveChatHistory()`, `getSessionMessages()`, `updateMessage()`, `deleteMessage()`
- **知识库**: `uploadToKnowledgeBase()`, `getKnowledgeBaseStatus()`, `searchKnowledgeBase()`, `clearKnowledgeBase()`
- **模型管理**: `getModelInfo()`, `switchModel()`, `setModelApiKey()`
- **认证**: `login()`, `register()`, `getProfile()`, `verifyToken()`, `changePassword()`, `uploadAvatar()`
- **摘要**: `getSessionSummary()`, `generateSessionSummary()`
- **记忆**: `getUserMemories()`, `addUserMemory()`, `deleteUserMemory()`, `updateUserMemory()`, `extractMemories()`

### 5.4 数据流

```
ChatAgent (UI)
   ↓ 调用
useChat hook (状态管理 + API 调用)
   ↓ 调用
lib/api.ts (fetch 封装)
   ↓ HTTP/SSE
NestJS 后端 (localhost:3000)
```

---

## 6. 后端服务端模块

### 6.1 模块划分

```
jerry-llm-server/src/
├── main.ts                  # 应用入口 (CORS/静态文件/bodyParser 配置)
├── app.module.ts            # NestJS 模块 (TypeORM 配置)
├── app.controller.ts        # API 路由层 (30+ 端点)
├── app.service.ts           # 业务逻辑编排层
├── auth/                    # 认证模块
│   ├── auth.controller.ts   # /auth/* 路由
│   ├── auth.service.ts      # 注册/登录/Token/密码逻辑
│   ├── auth.guard.ts        # JWT 守卫
│   └── auth.module.ts       # 认证模块注册
├── entities/                # TypeORM 实体
│   ├── user.entity.ts
│   ├── session.entity.ts
│   ├── chat-history.entity.ts
│   ├── session-summary.entity.ts
│   └── user-memory.entity.ts
└── fundamentals/            # AI 核心能力
    ├── prompt.ts            # 系统提示词构建 + 多模态消息处理 + 流式调用
    ├── rag-service.ts       # RAG 服务 (文档上传/检索/LLM 回答)
    ├── vector-store.ts      # 向量存储 (ChromaDB + BM25 混合搜索)
    ├── model-provider.ts    # 模型管理 (Ollama/DeepSeek 切换)
    ├── document-parser.ts   # 文档解析 (TXT/PDF/Word)
    ├── summarizer.ts        # 对话摘要生成
    ├── memory-extractor.ts  # 用户记忆提取
    └── delivery/            # 两阶段交付 (2026-11 新增)
        ├── delivery-plan.ts       # DeliveryPlan zod schema + fc:// 附件引用协议
        ├── delivery-executor.ts   # 交付执行器: 幂等→附件校验→发送→回执
        └── delivery-plan-store.ts # 计划 Redis 持久化 + 崩溃补偿扫描
```

### 6.2 API 端点清单

| 方法 | 路由 | 功能 | 认证 |
|------|------|------|------|
| POST | `/prompt` | AI 流式对话 (SSE) | 否 |
| POST | `/chat-history` | 保存聊天消息 | 否 |
| GET | `/chat-history` | 获取会话历史 | 否 |
| GET | `/sessions` | 获取所有会话 | 否 |
| POST | `/sessions` | 创建会话 | 否 |
| GET | `/sessions/:id` | 获取会话详情 | 否 |
| PUT | `/sessions/:id` | 更新会话标题 | 否 |
| DELETE | `/sessions/:id` | 删除会话 | 否 |
| PATCH | `/sessions/:id/pin` | 切换置顶 | 否 |
| GET | `/sessions/:id/messages` | 获取会话消息 | 否 |
| GET | `/sessions/:id/summary` | 获取会话摘要 | 否 |
| POST | `/sessions/:id/summary` | 生成会话摘要 | 否 |
| POST | `/upload` | 上传文件 | 否 |
| PUT | `/messages/:id` | 更新消息 | 否 |
| DELETE | `/messages/:id` | 删除消息 | 否 |
| POST | `/knowledge/upload` | 上传知识库文档 | 否 |
| GET | `/knowledge/status` | 知识库状态 | 否 |
| POST | `/knowledge/search` | 向量搜索 | 否 |
| POST | `/knowledge/hybrid-search` | 混合搜索 (向量+BM25) | 否 |
| DELETE | `/knowledge/clear` | 清空知识库 | 否 |
| GET | `/models` | 获取模型信息 | 否 |
| POST | `/models/switch` | 切换模型 | 否 |
| POST | `/models/apikey` | 设置 API Key | 否 |
| POST | `/auth/register` | 用户注册 | 否 |
| POST | `/auth/login` | 用户登录 | 否 |
| GET | `/auth/profile` | 获取用户信息 | 是 |
| PUT | `/auth/profile` | 更新用户信息 | 是 |
| GET | `/auth/verify` | 验证 Token | 是 |
| PUT | `/auth/password` | 修改密码 | 是 |
| POST | `/auth/avatar` | 上传头像 | 是 |
| GET | `/memories` | 获取用户记忆 | 否 |
| POST | `/memories` | 添加用户记忆 | 否 |
| PUT | `/memories/:id` | 更新用户记忆 | 否 |
| DELETE | `/memories/:id` | 删除用户记忆 | 否 |
| DELETE | `/memories` | 清空用户记忆 | 否 |
| POST | `/memories/extract/:sessionId` | 触发记忆提取 | 否 |

### 6.3 关键函数说明

#### [prompt.ts](file:///e:/miaoma-ai-app/servers/jerry-llm-server/src/fundamentals/prompt.ts) - 对话核心

| 函数 | 作用 |
|------|------|
| `promptTemplate()` | 主入口：RAG 检索 → 构建 System Prompt (注入知识库/摘要/记忆) → 构建消息 → LLM 流式调用 |
| `downloadImageAsBase64()` | 下载远程图片转 base64 |
| `processImageUrl()` | 处理图片 URL（本地图片下载转 base64，远程图片保持原 URL） |
| `convertToMultimodalContent()` | 将 Markdown 文本转换为多模态消息格式（文本+图片混合） |
| `createUserMessage()` | 创建 HumanMessage 对象 |

#### [vector-store.ts](file:///e:/miaoma-ai-app/servers/jerry-llm-server/src/fundamentals/vector-store.ts) - 向量存储

| 函数 | 作用 |
|------|------|
| `initializeVectorStore()` | 初始化 ChromaDB 向量存储（持久化） |
| `addDocuments()` | 添加文档到知识库（文本分割 → 向量化 → 存储 + BM25 索引） |
| `searchKnowledgeBase()` | 向量相似性搜索（带阈值过滤） |
| `hybridSearchKnowledgeBase()` | 混合搜索（向量 + BM25，RRF 融合） |
| `clearKnowledgeBase()` | 清空知识库（删除并重建 ChromaDB 集合 + BM25 索引） |
| `initializeBM25Index()` | 初始化 MiniSearch BM25 全文索引（支持持久化） |
| `previewChunking()` / `previewEmbedding()` | 调试预览工具 |

#### [model-provider.ts](file:///e:/miaoma-ai-app/servers/jerry-llm-server/src/fundamentals/model-provider.ts) - 模型管理

| 函数 | 作用 |
|------|------|
| `createLLM()` | 根据当前模型配置创建 LangChain LLM 实例 |
| `switchModel()` | 切换当前模型（校验 API Key） |
| `buildModelConfig()` | 构建模型配置（provider/model/temperature/baseUrl） |
| `getModelInfo()` | 获取模型状态（当前模型/可用模型/API Key 状态/视觉能力） |
| `setDeepseekApiKey()` | 设置 DeepSeek API Key（内存存储） |

---

## 7. 数据库设计

### 7.1 实体关系图

```
users (User)
  ├── id (PK, auto)
  ├── email (unique, nullable)
  ├── phone (unique, nullable)
  ├── username (unique, nullable)
  ├── password (bcrypt)
  ├── avatar (nullable)
  ├── isActive
  └── createdAt / updatedAt

sessions (Session)
  ├── id (PK, auto)
  ├── sessionId (unique)
  ├── title
  ├── userId (default: 'default')
  ├── isPinned
  └── createdAt / updatedAt

chat_history (ChatHistory)
  ├── id (PK, auto)
  ├── userId (default: 'default')
  ├── sessionId
  ├── role (user/assistant)
  ├── content (text)
  └── createdAt / updatedAt

session_summaries (SessionSummary)
  ├── id (PK, auto)
  ├── sessionId (unique)
  ├── summaryContent (text)
  ├── coveredMessageCount
  ├── userId (default: 'default')
  └── createdAt / updatedAt

user_memories (UserMemory)
  ├── id (PK, auto)
  ├── content (text)
  ├── category (preference/fact/decision/context/skill)
  ├── sourceSessionId (nullable)
  ├── userId (default: 'default')
  ├── importance (1-5)
  ├── accessCount
  └── createdAt / updatedAt
```

### 7.2 配置信息

- **数据库**: MySQL, 主机 `127.0.0.1:3306`, 数据库名 `cyberpunk`, 用户 `root/123456`
- **synchronize: true** - TypeORM 自动同步表结构（生产环境应关闭）

---

## 8. RAG 知识库系统

### 8.1 完整流程

```
用户上传文档 (TXT/PDF/Word)
  ↓
document-parser.ts 解析文档 → 纯文本
  ↓
RecursiveCharacterTextSplitter 切分 (chunkSize=400, overlap=80)
  ↓
ChromaDB 向量化存储 (bge-m3 embedding，本地 Ollama 优先 / 自动降级云端)
  ↓
MiniSearch BM25 全文索引
  ↓
用户提问 → hybridSearchKnowledgeBase() (向量 + BM25, RRF 融合)
  ↓
构建 System Prompt (注入检索到的文档片段)
  ↓
LLM 生成回答
```

### 8.2 关键配置

| 参数 | 值 | 说明 |
|------|-----|------|
| Chunk Size | 400 | 文本块大小 |
| Chunk Overlap | 80 | 块间重叠 |
| 分隔符 | `\n\n`, `\n`, `。`, `！`, `？`, `.`, `!`, `?`, ` `, `` | 多语言分句 |
| Embedding | bge-m3（本地 Ollama / 云端） | 1024 维、8192 tokens、多语言；本地与云端同权重，共用同一集合 |
| 向量距离 | cosine | 余弦相似度 |
| 相似度阈值 | <= 0.55 | 低于此值才保留 |
| BM25 k1 | 1.5 | 词频饱和参数 |
| BM25 b | 0.75 | 文档长度归一化 |
| RRF k | 10 | RRF 融合参数 |
| 向量权重 | 0.7 | 混合搜索中向量检索权重 |
| BM25 权重 | 0.3 | 混合搜索中 BM25 权重 |

---

## 9. 对话摘要与长期记忆系统

### 9.1 三层记忆体系

| 层级 | 载体 | 生命周期 | 用途 |
|------|------|---------|------|
| **短期记忆** | 对话历史 (history) | 当前对话内 | 最近 10 条消息注入上下文 |
| **中期记忆** | SessionSummary | 会话级别 | 超过 10 条消息时生成摘要，注入 System Prompt |
| **长期记忆** | UserMemory | 用户级别 (跨会话) | 从所有会话提取的用户画像，按重要性排序注入 |

### 9.2 摘要触发机制

- **首次生成**: 会话消息数 >= 10 条时触发
- **增量更新**: 已覆盖消息数与总消息数差值 >= 10 条时触发
- **生成方式**: 优先 DeepSeek LLM（高质量），降级本地简单截断
- **注入方式**: 摘要追加到 System Prompt 中

### 9.3 记忆提取机制

- **触发频率**: 每 10 条消息提取一次
- **提取方式**: DeepSeek LLM 提取结构化记忆（content/category/importance）
- **去重合并**: 新记忆与已有记忆通过 LLM 进行三重关系判断（duplicate/update/new）
- **注入方式**: 取最重要的 20 条记忆注入 System Prompt
- **分类**: preference(偏好) / fact(事实) / decision(决策) / context(上下文) / skill(技能)

---

## 10. LLM 模型管理层

### 10.1 支持的模型

| ID | 名称 | 提供商 | 视觉能力 | 需要 API Key |
|----|------|--------|---------|-------------|
| `ollama:minicpm` | MiniCPM (本地) | Ollama | 是 | 否 |
| `ollama:qwen3.5-new` | Qwen3.5 New (本地) | Ollama | 否 | 否 |
| `ollama:qwen3.5-2b` | Qwen3.5 2B (本地) | Ollama | 否 | 否 |
| `deepseek:deepseek-v4-flash` | DeepSeek-V4-Flash | DeepSeek | 否 | 是 |
| `deepseek:deepseek-v4-pro` | DeepSeek-V4-Pro | DeepSeek | 否 | 是 |

### 10.2 LLM 创建逻辑

```
当前模型 ID
  ↓
buildModelConfig() → 解析 provider:model 格式
  ↓
provider === 'ollama' → ChatOllama (localhost:11434)
provider === 'deepseek' → ChatOpenAI (api.deepseek.com, 需要 API Key)
  ↓
createLLM() → 返回 BaseChatModel 实例
```

---

## 11. 用户认证系统

### 11.1 认证流程

```
注册: POST /auth/register
  → 验证邮箱/手机/密码格式
  → 检查唯一性
  → bcrypt.hash(password, 10)
  → 创建用户
  → JWT.sign → 返回 Token + 用户信息

登录: POST /auth/login
  → 匹配 username/email/phone
  → bcrypt.compare
  → JWT.sign → 返回 Token + 用户信息

受保护接口:
  → AuthGuard 验证 JWT (Authorization: Bearer <token>)
  → 从 token.payload.sub 获取 userId
  → 注入 req.user
```

### 11.2 JWT 配置

- **密钥**: `process.env.JWT_SECRET || 'miaoma-ai-secret-key-2024'`（硬编码默认密钥）
- **有效期**: 7 天
- **Payload**: `{ sub: userId, email, phone, username }`

---

## 12. 依赖关系图

```
                    ┌──────────────┐
                    │   ChatAgent  │
                    │   (页面组件)  │
                    └──────┬───────┘
                           │ 使用
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         ┌────────┐  ┌──────────┐  ┌─────────┐
         │useChat │  │ useAuth  │  │useTheme │
         └───┬────┘  └────┬─────┘  └─────────┘
             │            │
             ▼            ▼
         ┌──────────────────────┐
         │    lib/api.ts        │
         │   (API 客户端)        │
         └──────────┬───────────┘
                    │ HTTP/SSE
                    ▼
         ┌──────────────────────┐
         │   AppController      │
         │   (路由层)            │
         └──────────┬───────────┘
                    │ 依赖注入
                    ▼
         ┌──────────────────────┐
         │    AppService        │
         │   (业务逻辑编排)       │
         └────┬─────┬─────┬─────┘
              │     │     │
        ┌─────┘     │     └──────┐
        ▼           ▼            ▼
  ┌──────────┐ ┌──────────┐ ┌──────────┐
  │fundamentals│ │ TypeORM  │ │ AuthService│
  │ (AI能力)  │ │ (数据访问)│ │ (认证)    │
  └────┬─────┘ └────┬─────┘ └──────────┘
       │            │
       ▼            ▼
  ┌──────────┐ ┌──────────┐
  │ ChromaDB │ │  MySQL   │
  │  Ollama  │ │          │
  └──────────┘ └──────────┘
```

---

## 13. 项目缺陷与改进方案

### 13.1 安全缺陷

| 编号 | 问题 | 严重性 | 改正方案 |
|------|------|--------|---------|
| S-1 | JWT 密钥硬编码默认值 `'miaoma-ai-secret-key-2024'`，生产环境泄漏风险 | **高** | 强制要求环境变量 `JWT_SECRET`，启动时检查，无值则拒绝启动 |
| S-2 | MySQL 密码硬编码 `'123456'`，数据库配置写死在代码中 | **高** | 使用环境变量或配置中心管理，`app.module.ts` 改为从 `process.env` 读取 |
| S-3 | CORS 设置为 `origin: '*'`，允许所有来源跨域 | **中** | 生产环境配置白名单域名列表，`app.enableCors({ origin: [...] })` |
| S-4 | 认证接口（登录/注册/聊天）全部无需 Token，未与 ChatHistory/Session 做用户隔离 | **高** | 核心 API 添加 `@UseGuards(AuthGuard)`，根据 token 中的 userId 过滤数据 |
| S-5 | 文件上传无用户隔离，所有用户上传文件存放在同一 `uploads/` 目录 | **中** | 按 userId 分目录存储：`uploads/{userId}/` |
| S-6 | `dangerouslySetInnerHTML` 用于搜索高亮，存在 XSS 风险 | **中** | 使用 DOMPurify 等库进行 XSS 清理 |
| S-7 | API Key 存储在内存变量中，服务重启后丢失 | **低** | 持久化到数据库或加密配置文件 |

### 13.2 架构缺陷

| 编号 | 问题 | 严重性 | 改正方案 |
|------|------|--------|---------|
| A-1 | 所有 API 路由集中在 `AppController` 单文件（665行），违反单一职责原则 | **中** | 拆分为独立 Controller：ChatController、SessionController、KnowledgeController、ModelController、MemoryController |
| A-2 | `ChatAgent.tsx` 单文件 1400 行，包含大量内联 JSX 和重复代码 | **中** | 拆分为子组件：ChatHeader、MessageList、MessageBubble、InputArea、ModelPanel、ApiKeyDialog |
| A-3 | 编辑会话标题直接调用 `fetch` API 并 `window.location.reload()` | **高** | 应通过 `useChat` hook 统一管理，使用乐观更新而非页面刷新 |
| A-4 | 所有数据使用 `'default'` 作为 userId，无真正多用户支持 | **高** | 将 userId 与 Auth 系统集成，登录后使用真实 userId |
| A-5 | `model-provider.ts` 中 `currentModelId` 和 `deepseekApiKey` 为全局变量，无并发安全性 | **中** | 使用 NestJS Provider + Scope 管理模型状态，或存储到 Redis/DB |
| A-6 | `app.module.ts` 中 `synchronize: true` 在生产环境会导致表结构被意外修改 | **高** | 生产环境关闭 synchronize，改用 TypeORM migration 管理 |
| A-7 | `fundamentals/` 下的文件使用动态 import (`await import('./rag-service.js')`) 避免循环依赖 | **中** | 重构模块依赖关系，使用 NestJS 的模块化依赖注入替代动态 import |

### 13.3 功能缺陷

| 编号 | 问题 | 严重性 | 改正方案 |
|------|------|--------|---------|
| F-1 | `sendFile()` 上传非图片文件时，将文件作为 Markdown 链接发送，但未将文件内容注入到上下文 | **低** | 对非图片文件也应解析内容后作为上下文注入 |
| F-2 | `clearPendingImages()` 删除所有待发送图片，无法单独删除某一张 | **低** | 增加按索引删除功能 |
| F-3 | 会话标题仅取前 50 字符，不经过 LLM 生成有意义的标题 | **低** | 使用 LLM 自动生成会话摘要标题 |
| F-4 | 记忆提取仅使用 `'default'` 用户 ID，不支持多用户独立记忆 | **中** | 与 Auth 系统对接，使用真实 userId |
| F-5 | 摘要生成仅在 `role === 'assistant'` 时触发，纯用户输入不触发 | **低** | 考虑在达到阈值时统一检查 |
| F-6 | 前端消息操作（编辑/删除）使用 `prompt()` 和 `confirm()`，体验差 | **低** | 改为模态对话框组件 |
| F-7 | `stopGeneration` 仅中断 SSE 流，不中断后端的 LLM 推理（LLM 仍会继续生成到结束） | **中** | 使用 AbortSignal 传递到 LLM 层（当前已部分实现 `isCancelled` 回调） |
| F-8 | 知识库文档上传后使用 `RecursiveCharacterTextSplitter` 统一切分，不同文档类型使用相同的 chunk 策略 | **中** | 根据文档类型使用不同的切分策略（如代码文件按函数切分） |

### 13.4 性能缺陷

| 编号 | 问题 | 严重性 | 改正方案 |
|------|------|--------|---------|
| P-1 | `addDocuments()` 的 `BATCH_SIZE = 1`，逐个添加文档到 ChromaDB，性能极差 | **高** | 增大 batch size 到 10-50，使用批量添加 |
| P-2 | `getSessionMessages()` 每次都从数据库加载全部消息，无分页 | **中** | 添加游标分页，前端按需加载更多 |
| P-3 | `loadSessions()` 在每次 sendMessage 后重新加载全部会话列表 | **低** | 改为乐观更新，仅修改变更的会话 |
| P-4 | 前端搜索会话为客户端过滤，会话量大时性能差 | **低** | 改为服务端搜索（SQL LIKE 或全文索引） |
| P-5 | BM25 索引每次添加文档都 `saveBM25Index()`（写磁盘），高并发时 I/O 压力大 | **中** | 改为定期批量持久化，或使用 debounce |
| P-6 | Embedding 使用 Ollama 本地模型，每次向量化都需要调用 HTTP 接口 | **中** | 使用内存缓存已向量化的 chunk，避免重复计算 |

---

## 14. 面向企业级应用的扩展方案

### 14.1 行业竞品对比与定位

| 维度 | 本项目 | ChatGPT Enterprise | Dify | Coze |
|------|--------|-------------------|------|------|
| 部署方式 | 本地桌面 + 自建后端 | 云端 SaaS | 可私有化部署 | 云端 SaaS |
| 多模型支持 | Ollama + DeepSeek | OpenAI 私有模型 | 多模型聚合 | 字节系模型 |
| 知识库 | ChromaDB + BM25 | 企业向量搜索 | 多向量库支持 | 内置知识库 |
| 记忆系统 | 摘要 + 长期记忆 | Conversation Memory | 对话记忆 | 用户画像 |
| 多租户 | ❌ | ✅ | ✅ | ✅ |
| 权限管理 | ❌ | RBAC | RBAC | RBAC |
| 审计日志 | ❌ | ✅ | ✅ | ✅ |

### 14.2 短期改进（1-2 个月）

1. **安全加固**
   - 环境变量配置化（JWT Secret、DB 密码）
   - API 鉴权全覆盖
   - 文件上传安全校验（MIME 类型、大小、病毒扫描）
   - 输入过滤和输出过滤（XSS、注入攻击防护）

2. **架构重构**
   - 拆分 Controller 为独立模块
   - 前端组件拆分和状态管理优化
   - TypeORM migration 替代 synchronize
   - 引入 Winston 结构化日志

3. **用户体验**
   - 代码块语法高亮优化
   - 对话复制/分享功能
   - 导入/导出对话数据
   - 打字机效果优化

### 14.3 中期改进（3-6 个月）

1. **多租户与权限系统**
   - 用户-组织-角色三级权限模型
   - API Key 管理（用户级 API Key，非 DeepSeek Key）
   - 数据隔离（每个用户/组织独立知识库和会话）

2. **知识库增强**
   - 多向量库支持（Pinecone, Weaviate, Milvus）
   - 文档版本管理
   - 自动爬取网页/飞书作为知识源
   - 文档权限控制（谁可以上传/查看/删除）

3. **Agent 能力**
   - Function Calling / Tool Use 支持
   - 代码执行沙箱
   - MCP (Model Context Protocol) 集成
   - 工作流编排（类似 Dify Workflow）

4. **监控与可观测性**
   - 对话成本统计（Token 消耗）
   - 响应延迟监控
   - 用户行为分析
   - A/B 测试框架

### 14.4 长期改进（6-12 个月）

1. **平台化**
   - Plugin/Plugin 市场（第三方扩展）
   - 开放 API（RESTful + WebSocket）
   - Webhook 集成
   - 企业 SSO（SAML/OIDC）

2. **AI 能力升级**
   - 多模态理解（图片/音频/视频）
   - 语音对话（TTS/STT）
   - 代码 Agent（自动写代码/Review/Debug）
   - 自动记忆遗忘策略（过期记忆清理）

3. **高可用架构**
   - 分布式部署（Kubernetes）
   - 消息队列（RabbitMQ/Kafka）解耦异步任务
   - Redis 缓存（会话缓存、模型配置缓存）
   - 负载均衡与自动扩缩容

---

## 附录

### A. 环境变量清单

当前项目未使用 `.env` 文件，以下为建议的环境变量：

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `PORT` | 3000 | 后端服务端口 |
| `DB_HOST` | 127.0.0.1 | MySQL 主机 |
| `DB_PORT` | 3306 | MySQL 端口 |
| `DB_USERNAME` | root | MySQL 用户名 |
| `DB_PASSWORD` | 123456 | MySQL 密码 |
| `DB_DATABASE` | cyberpunk | 数据库名 |
| `JWT_SECRET` | miaoma-ai-secret-key-2024 | JWT 签名密钥 |
| `JWT_EXPIRES_IN` | 7d | JWT 有效期 |
| `OLLAMA_BASE_URL` | http://localhost:11434 | Ollama 服务地址 |
| `CHROMADB_URL` | http://localhost:8000 | ChromaDB 服务地址 |
| `DEEPSEEK_API_URL` | https://api.deepseek.com | DeepSeek API 地址 |
| `MAX_FILE_SIZE` | 20MB | 最大上传文件大小 |

### B. 数据库建表语句（TypeORM 自动生成）

由于 `synchronize: true`，表结构由 TypeORM 自动创建。生产环境应使用以下 Migration 管理：

```bash
npx typeorm migration:generate -d src/data-source.ts src/migrations/InitialSchema
npx typeorm migration:run -d src/data-source.ts
```

### C. 测试策略

当前项目包含基础测试配置（Jest），但测试覆盖率较低。建议补充：

- **单元测试**: `fundamentals/` 下各模块（document-parser, vector-store, summarizer）
- **集成测试**: API 端点（/prompt, /knowledge/upload, /auth/login）
- **E2E 测试**: 完整对话流程
- **前端测试**: React 组件渲染测试（Testing Library）
