# 后端 E2E 测试

> 作用域：`servers/jerry-llm-server/test/`
> 关联规范：`.trae/rules/global.md` 第 9 节 / `nestjs-backend.md` 第 9.2 节

---

## 运行方式

```bash
# 在 servers/jerry-llm-server 目录下
pnpm test:e2e
```

底层执行：`jest --config ./test/jest-e2e.json`

---

## 目录约定

```
test/
├── jest-e2e.json     # E2E 专用 Jest 配置（rootDir=.，匹配 *.e2e-spec.ts）
├── README.md         # 本文件
├── helpers/          # 共享工具：测试 App 启动、登录获取 token、清库等（按需新建）
├── fixtures/         # 测试数据：mock JSON、固定 SQL seed（按需新建）
└── *.e2e-spec.ts     # E2E 用例
```

- **单元测试** (`*.spec.ts`) 与源文件同级共存（co-location），不在本目录管。
- **E2E 测试** 跨多个模块，集中放在本目录。命名后缀必须是 `.e2e-spec.ts`。

---

## 编写规范

1. **必须 Mock 外部 AI / LLM 调用**（LangChain、OpenAI、ChromaDB），保证测试可重复、不消耗配额。
2. **数据库**：建议用独立的 `MIAOMA_TEST_DB` 数据库，每个 `describe` 前清表。如果用 `synchronize: true` 的 dev 库，跑 E2E 前请确认数据可丢弃。
3. **Redis**：测试前设置 `REDIS_ENABLED=false`，避免污染开发环境的 Redis。
4. 必须复刻 `main.ts` 的全局管道：`app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))`。
5. 用 `supertest` 发起 HTTP 请求，断言用 Jest 内置 `expect`。

---

## 推荐的核心业务流（待补充）

按优先级排序（参考 `nestjs-backend.md` 9.2 条）：

- [ ] `auth.e2e-spec.ts` — 注册 → 登录 → 获取个人信息 → 修改密码
- [ ] `chat.e2e-spec.ts` — 创建会话 → 发送消息（Mock LLM）→ 收到 SSE 流 → 历史查询
- [ ] `knowledge.e2e-spec.ts` — 上传文档 → 触发向量化（Mock）→ 检索 → 删除

当前仓库仅提供 `app.e2e-spec.ts` 健康检查样例，其他用例按需补充。
