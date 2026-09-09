# =============================================================================
# jerry-llm-server 生产镜像（多阶段构建）
#
# 构建上下文必须是 monorepo 根目录（pnpm-lock.yaml 在根目录）：
#   docker build -f servers/jerry-llm-server/Dockerfile -t jerry-llm-server:latest .
#
# 日常部署直接用 docker/docker-compose.prod.yml，无需手动执行以上命令。
#
# 密钥安全：本镜像不包含也不 COPY 任何 .env；运行时由 compose env_file 注入。
# =============================================================================

# ---------- 阶段 1：完整依赖（含 devDependencies，用于编译） ----------
FROM node:22-alpine AS deps
# pnpm v10 读取 lockfileVersion 9.0
RUN npm install -g pnpm@10
WORKDIR /app
# 先只拷贝 manifest + lockfile，利用 Docker 层缓存：代码变更不触发依赖重装
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY clients/jerry-ai-app/package.json clients/jerry-ai-app/
COPY servers/jerry-llm-server/package.json servers/jerry-llm-server/
# 只安装 server 子包的依赖（含 devDeps，编译需要）；跳过 puppeteer 的 Chromium 下载
# （服务器上联网搜索工具会在无浏览器时自动跳过注册，如需容器内爬虫另行加装 chromium）
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN pnpm --filter jerry-llm-server install --frozen-lockfile

# ---------- 阶段 2：编译 TypeScript ----------
FROM deps AS build
COPY servers/jerry-llm-server/ servers/jerry-llm-server/
RUN pnpm --filter jerry-llm-server build

# ---------- 阶段 3：生产依赖（不含 devDependencies） ----------
FROM node:22-alpine AS prod-deps
RUN npm install -g pnpm@10
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY clients/jerry-ai-app/package.json clients/jerry-ai-app/
COPY servers/jerry-llm-server/package.json servers/jerry-llm-server/
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN pnpm --filter jerry-llm-server install --frozen-lockfile --prod

# ---------- 阶段 4：运行镜像 ----------
FROM node:22-alpine AS runner
ENV NODE_ENV=production
# 国内服务器访问 Alpine 官方 CDN（Fastly）极慢，apk 下载会卡 20 分钟以上；
# 腾讯云内网镜像免费且快（非腾讯云环境可换 mirrors.aliyun.com）
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.cloud.tencent.com/g' /etc/apk/repositories \
  && apk add --no-cache wget
# 图表 PNG 渲染 / 网页爬虫依赖 Chromium（Alpine musl 版）；
# font-noto-cjk 提供中文字体，缺字体会导致图表中文渲染成方块
RUN apk add --no-cache chromium font-noto-cjk \
  && ln -sf /usr/bin/chromium-browser /usr/bin/google-chrome
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
WORKDIR /app

# pnpm workspace 布局：根 node_modules/.pnpm 为真实存储，子包 node_modules 是符号链接，
# 两处都要拷贝且保持相对路径结构不变
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/servers/jerry-llm-server/node_modules ./servers/jerry-llm-server/node_modules
# 编译产物（dist/src/main.js 为入口，nest-cli assets 已随构建拷入 dist）
COPY --from=build /app/servers/jerry-llm-server/dist ./servers/jerry-llm-server/dist
COPY servers/jerry-llm-server/package.json servers/jerry-llm-server/

# 以非 root 运行；上传/日志等可写目录通过 compose 卷挂载（挂载点需先存在且归属 node 用户）
RUN chown -R node:node /app
USER node
WORKDIR /app/servers/jerry-llm-server

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/metrics > /dev/null || exit 1

CMD ["node", "dist/src/main.js"]
