# 秒码 AI（Jerry LLM Server）

基于 NestJS 11 + TypeORM + LangChain 的 AI 应用后端，集成多模型路由、RAG 知识库、Agent 工具调用、飞书双向通信、语音识别等能力。

## 快速开始（5 分钟）

### 前置条件

- Node.js 20+
- pnpm 9+
- Docker（用于依赖服务）

### 1. 启动依赖服务

```bash
cd servers/jerry-llm-server/docker
docker compose -f docker-compose.dev.yml up -d
```

这会拉起 MySQL 8、Redis 7、ChromaDB、Ollama 四个容器，数据持久化到 Docker volume。

### 2. 拉取 Ollama 模型

```bash
# 本地对话模型（按需选择一个或多个）
docker exec jerry-ollama-dev ollama pull minicpm
docker exec jerry-ollama-dev ollama pull qwen3.5:2b

# 嵌入模型（RAG 知识库必需）
docker exec jerry-ollama-dev ollama pull bge-large
```

### 3. 配置环境变量

```bash
cd servers/jerry-llm-server
cp .env.example .env
```

编辑 `.env`，至少设置以下项：

```bash
# 必填：JWT 密钥（随机字符串即可）
JWT_SECRET=your-random-secret-here

# 数据库（与 docker-compose.dev.yml 默认值一致，无需改动）
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USERNAME=root
DB_PASSWORD=123456
DB_DATABASE=cyberpunk
TYPEORM_SYNCHRONIZE=false

# Redis（可选，启用后获得缓存 + 限流 + 分布式锁能力）
REDIS_ENABLED=true
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# 向量数据库 & 本地 LLM（与 docker-compose.dev.yml 默认值一致）
CHROMA_URL=http://localhost:8000
OLLAMA_BASE_URL=http://localhost:11434
```

### 4. 安装依赖 & 运行数据库迁移

```bash
pnpm install
pnpm migration:run
```

### 5. 启动开发服务器

```bash
pnpm start:dev
```

服务启动在 http://localhost:3000，健康检查：http://localhost:3000/api/health

### 6. 启动前端（Tauri 桌面端）

```bash
cd clients/jerry-ai-app
pnpm install
pnpm tauri dev
```

前端开发服务器在 http://localhost:1420。

## 健康检查

```bash
curl http://localhost:3000/api/health
```

返回 MySQL / Redis 连通性状态，供 Docker HEALTHCHECK 和负载均衡探活使用。

## 常用命令

```bash
# 数据库迁移
pnpm migration:run        # 执行迁移
pnpm migration:revert     # 回滚最近一次迁移
pnpm migration:generate   # 根据实体变更生成新迁移

# 测试
pnpm test                 # 单元测试
pnpm test:e2e             # E2E 测试

# 构建
pnpm build                # 编译到 dist/
```

## 项目结构

```
servers/jerry-llm-server/
├── src/
│   ├── controllers/          # HTTP 控制器（只做转发）
│   ├── services/             # 业务逻辑层
│   ├── entities/             # TypeORM 实体
│   ├── fundamentals/         # 基础设施（跨模块共享）
│   │   ├── config.ts         # zod 配置校验
│   │   ├── logger.ts         # Winston 日志
│   │   ├── redis-client.ts   # Redis 客户端（可选）
│   │   ├── multi-level-cache.ts  # L1+L2 多级缓存
│   │   ├── model-provider.ts # 多模型路由
│   │   ├── tools/            # LangChain Agent 工具
│   │   ├── vector-store/     # ChromaDB 向量存储
│   │   └── ...
│   ├── auth/                 # JWT 认证模块
│   └── gateways/             # WebSocket 网关
├── migrations/               # TypeORM 迁移文件
└── docker/                   # Docker 编排
    ├── docker-compose.yml        # 可观测性栈（Loki/Prometheus/Grafana）
    └── docker-compose.dev.yml    # 开发依赖（MySQL/Redis/Chroma/Ollama）
```

## 环境变量说明

完整环境变量见 `.env.example`，所有配置通过 zod 在启动时校验，缺失必填项会拒绝启动。
