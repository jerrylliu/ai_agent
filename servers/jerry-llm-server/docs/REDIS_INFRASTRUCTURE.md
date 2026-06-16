# 基于 Redis 的多级缓存 / 限流 / 分布式锁实战

> jerry-llm-server 中 Redis 相关基础设施的设计文档与面试讲稿。
> 本文档同时也是工程内部参考，所有决策都附了"为什么这样做、不这样做的代价"。

---

## 0. 背景与目标

### 业务场景
jerry-llm-server 是一个 AI 对话服务（NestJS + LangChain），支持多模态生成（PDF / 图片 / 图表 / 思维导图）+ 工具调用（搜索 / 邮件 / 数据库）。AI 生成的资产 URL 需要**跨轮对话复用**——比如用户先让 AI 生成一份周报，再说"发给老板"，第二轮请求要能引用第一轮生成的 PDF URL，而不是重新生成。

### 改造前的问题
1. 进程内 `Map` 缓存：服务重启即丢失，多实例部署各自为政
2. 没有限流：AI 接口每次调用 LLM，恶意刷取直接烧 Token
3. 没有并发控制：用户连点 send 会触发多次 LLM 调用，回复乱序

### 改造目标
- ✅ **缓存可持久 + 跨实例共享**（多级缓存）
- ✅ **接口可限流，防刷不烧钱**（基于 Redis 的滑动窗口）
- ✅ **同会话不能并发**（分布式锁）
- ✅ **Redis 故障不影响主业务**（全链路降级）

---

## 1. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Controller 层                              │
│   ┌──────────────────┐  ┌──────────────────┐               │
│   │ OptionalAuthGuard│→ │ RateLimitGuard   │  滑动窗口限流  │
│   └──────────────────┘  └──────────────────┘               │
│            ↓                                                  │
│   ┌──────────────────┐                                      │
│   │ acquireLock      │  会话级分布式锁                       │
│   │ (sessionId)      │                                      │
│   └──────────────────┘                                      │
└────────────┬────────────────────────────────────────────────┘
             ↓
┌─────────────────────────────────────────────────────────────┐
│                    Service 层                                 │
│   ┌────────────────────────────────────────┐               │
│   │  MultiLevelCache<SessionAssetEntry>    │               │
│   │   ┌──────────┐    ┌──────────┐        │               │
│   │   │ L1 LRU   │ →  │ L2 Redis │        │               │
│   │   │ 内存     │    │ 共享缓存 │        │               │
│   │   └──────────┘    └──────────┘        │               │
│   └────────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────┘
             ↓
┌─────────────────────────────────────────────────────────────┐
│              fundamentals/redis-client.ts                    │
│  · lazy init  · 自动降级  · 优雅关闭  · 全事件监听           │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 核心模块说明

| 模块 | 文件 | 职责 |
|------|------|------|
| Redis 客户端 | `src/fundamentals/redis-client.ts` | 单例 / lazy init / 降级 / 优雅关闭 |
| 多级缓存 | `src/fundamentals/multi-level-cache.ts` | L1 LRU + L2 Redis 双层缓存 |
| 分布式锁 | `src/fundamentals/distributed-lock.ts` | SET NX EX + Lua 安全释放 |
| 限流 Guard | `src/auth/rate-limit.guard.ts` | 滑动窗口算法（ZSET） |
| 配置 | `src/fundamentals/config.ts` | redis / rateLimit 配置块 |

---

## 3. 关键设计决策（FAQ）

### Q1：为什么不直接用 NestJS 的 `@nestjs/cache-manager` 或 `@nestjs/throttler`？

- **`@nestjs/cache-manager`**：功能不足。它是单层缓存抽象，没有 L1+L2 多级、没有 TTL 抖动、没有降级语义。
- **`@nestjs/throttler`**：内置只支持内存存储；要接 Redis 需要 `@nestjs/throttler-storage-redis`，且不支持滑动窗口（默认是固定窗口）。
- **结论**：这些库对我们的需求过浅，不如自己写一套，逻辑清晰、可定制。

### Q2：多级缓存为什么要分 L1 + L2？只用 Redis 不行吗？

可以用，但不优。
- **L1 命中**：< 0.1ms（内存读）
- **L2 命中**：1-3ms（本地 Redis 网络 IO）
- **差距**：10-30 倍

对于读热点（热门 sessionId 在短时间内多次访问），L1 能挡住绝大多数请求，**减少 Redis QPS 90%+**。同时 L1 的内存开销极小（每条目几 KB），LRU 淘汰自动控制规模。

### Q3：你的多级缓存怎么解决"缓存穿透 / 击穿 / 雪崩"？

- **穿透**（请求不存在的 key 一直打到回源层）：`set()` 拒绝写入 null/undefined（防污染）；如需"缓存空结果防恶意请求"可以由业务层显式传入哨兵值（如 `{}`）
- **击穿**（热点 key 过期瞬间大量并发回源）：当前未实现单飞（singleflight），因为业务侧（LLM 调用）本身有分布式锁兜底。如果未来要做，可以加 `inflight = new Map<key, Promise>()`
- **雪崩**（大量 key 同时过期）：`ttlJitterRatio` 默认 0.1，给 TTL 加 ±10% 随机偏移，把过期时间打散

### Q4：限流为什么选滑动窗口，不选令牌桶 / 漏桶？

| 算法 | 优点 | 缺点 |
|------|------|------|
| **固定窗口** | 实现最简单 | 临界突刺：59秒30次 + 01秒30次 = 2秒60次 |
| **滑动窗口** ✅ | 平滑、无突刺、ZSET 原生支持 | 内存稍多（每请求一个 ZSET 成员） |
| **令牌桶** | 允许小幅突发 | Redis 实现需 Lua 保证原子，复杂 |
| **漏桶** | 强制平滑、下游恒定 | 不适合 LLM（不能排队，需立即返回） |

我们选滑动窗口：**实现简单、无突刺、对 LLM 场景友好**。

### Q5：滑动窗口具体怎么做的？

用 Redis ZSET：
1. `ZREMRANGEBYSCORE key -inf (now-windowMs)` — 清掉窗口外旧记录
2. `ZCARD key` — 统计当前窗口内请求数
3. `ZADD key now uniqueMember` — 记录本次请求
4. `EXPIRE key (windowSec + 5)` — 兜底过期

**4 个命令用 `MULTI` 事务包成原子操作**，避免并发场景下统计偏差。

代码：[`rate-limit.guard.ts`](../servers/jerry-llm-server/src/auth/rate-limit.guard.ts)

### Q6：为什么 ZSET 成员要用 `${now}-${random}` 而不是 `now`？

ZSET 成员要求**唯一**。同一毫秒内的两次请求如果用 `now`，第二次 ZADD 会被去重，导致**少算一次**。加随机后缀保证唯一性。

### Q7：分布式锁为什么要用 Lua 脚本释放？

否则有竞态：
```
T1: GET key 拿到 myValue
T2: 锁 TTL 到期，自动释放
T3: 重新获取锁，新 value = otherValue
T1: DEL key  ← 删掉了 T3 的锁！
```

Lua 脚本 `if GET == myValue then DEL` 把校验+删除包成原子操作，杜绝竞态。
代码：[`distributed-lock.ts`](../servers/jerry-llm-server/src/fundamentals/distributed-lock.ts) 中的 `RELEASE_LOCK_SCRIPT`

### Q8：分布式锁为什么不用 Redlock？

Redlock 论文要求 N≥5 个独立 Redis 节点投票，复杂度高。我们的场景：
- **单 Redis 节点**：主从切换瞬间确实可能丢锁，但发生概率极低
- **业务时长可控**：LLM 流式响应一般 < 30s，锁 TTL 设 5 分钟，几乎不会被自动释放
- **业务可重试**：即使锁被错误释放，并发执行最多导致多调一次 LLM（前端会显示重复消息），不会造成严重事故

**结论**：单节点 SET NX EX 已满足需求，不引入 Redlock 的复杂度。

### Q9：业务执行时间超过锁 TTL 怎么办？

进阶方案是 **watchdog 自动续期**（如 Redisson）：获取锁后启动定时器，每 `ttl/3` 秒续期一次，业务释放时停定时器。

我们当前实现提供了 `renewLock()` API，但没自动启 watchdog——因为业务侧没有这个需求（LLM 调用最长 < 30s，TTL 设 5 分钟）。如果未来有长时业务，可以再加 watchdog 包装层。

### Q10：Redis 挂了你的系统会怎样？

**分场景降级**：
| 模块 | Redis 不可用时的行为 |
|------|----------------------|
| `MultiLevelCache.get` | L1 命中返回，L1 miss 返回 null（业务回源） |
| `MultiLevelCache.set` | L1 写成功，L2 写失败仅日志 |
| `RateLimitGuard` | 按 `RATE_LIMIT_FAIL_OPEN` 决策（默认 fail-open，体验优先） |
| `acquireLock` | 返回 null，由业务决定是放行（降级）还是拒绝（fail-close） |

**核心原则**：Redis 是基础设施，不能让它影响主业务。

### Q11：限流应该 fail-open 还是 fail-close？

- **fail-open**：体验优先，适合普通业务（限流挂了不至于全员被拒）
- **fail-close**：安全优先，适合金融 / 强合规（不能让限流失效，宁可拒服务）

我们做成**配置项**：`RATE_LIMIT_FAIL_OPEN=true|false`。本项目默认 `true`，因为 AI 接口的"被刷"风险远低于"全员被拒"的体验损失。

### Q12：Key 命名为什么要带前缀 `jerry:`？

1. **业务隔离**：多业务共用一个 Redis 时（公司级缓存集群很常见），加前缀避免 key 冲突
2. **批量清理**：`SCAN MATCH jerry:* | UNLINK` 可以一键清理本业务所有 key（注意：禁用 `KEYS`，会卡死 Redis）
3. **可观测性**：Redis Desktop Manager 等工具会按冒号自动折叠成树状视图

ioredis 提供 `keyPrefix` 选项**自动追加**前缀，业务代码内的 `redis.set('foo', ...)` 实际写入的是 `jerry:foo`，无需手动拼接。

### Q13：为什么用 `UNLINK` 不用 `DEL`？

- `DEL`：同步删除，对大 key（如 ZSET 1M 成员）会阻塞 Redis 主线程
- `UNLINK`（Redis 4.0+）：异步释放内存，主线程立即返回

我们的限流 ZSET、缓存 STRING 都不大，用哪个都行——但写代码时养成 `UNLINK` 习惯，未来遇到大 key 不踩坑。

### Q14：`enableOfflineQueue: false` 是什么？为什么这样配？

ioredis 默认 `enableOfflineQueue=true`：连接未就绪时把命令排队，连上后批量发送。
- **问题**：业务发请求后等几秒突然全部返回，行为不可控；超时取消的命令仍可能被执行
- **我们的做法**：关掉队列，连接未就绪时立即抛错，由 try/catch 走降级路径——**fail fast，不堆积**

### Q15：为什么 fire-and-forget 写缓存？

`saveSessionAssets` 不 `await`，用 `.catch(...)` 兜底：
- **理由**：缓存写入失败不应阻塞 LLM 流式响应（业务核心路径）
- **风险**：如果调用方需要"写完才能继续"才能正确，这种模式会出问题
- **本项目**：缓存仅用于"下一轮注入"，本轮响应不依赖它，fire-and-forget 是安全的
- **其他场景**：写完立即读（如刚 set 立即 get），就必须 await，否则可能读不到

---

## 4. 配置说明

### `.env` 关键项
```ini
# Redis 总开关；false = 全链路走内存降级
REDIS_ENABLED=true
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
REDIS_KEY_PREFIX=jerry:
REDIS_COMMAND_TIMEOUT_MS=300

# 单用户每分钟最多 30 次 AI 对话；0 = 不限流
RATE_LIMIT_CHAT_PER_MIN=30
# 限流降级策略：true=fail-open（放行），false=fail-close（拒绝）
RATE_LIMIT_FAIL_OPEN=true
```

### 部署建议

| 部署形态 | 推荐配置 |
|---------|---------|
| 个人开发机 | `REDIS_ENABLED=false`（零依赖，全部内存） |
| 单机生产环境（< 50 用户） | `REDIS_ENABLED=true`，本地 Redis |
| 多实例生产环境 | `REDIS_ENABLED=true`，独立 Redis（含 AUTH + 内网） |

---

## 5. 性能数据（参考）

> 测试环境：本地 Redis 7.2，4 核 8G

| 操作 | 平均耗时 | 备注 |
|------|---------|------|
| L1 命中（Map.get） | ~0.05 ms | 主要是 V8 内部 |
| L2 命中（redis.get） | ~1.5 ms | 含网络往返 |
| L2 写（redis.set） | ~1.8 ms | 含网络往返 |
| 限流检查（multi 4 条命令） | ~3 ms | 含 ZADD/ZCARD 等 |
| 锁获取（SET NX EX） | ~1 ms | 单命令 |
| 锁释放（Lua eval） | ~1.5 ms | Lua 脚本一次往返 |

**结论**：Redis 操作的额外开销对 LLM 业务（动辄 1-30s）来说**完全可忽略**。

---

## 6. 运维与监控

### 命中率观察
```ts
import { sessionAssetCache } from '...';  // 实际使用 getStats()
console.log(sessionAssetCache.getStats());
// {
//   namespace: 'session-asset',
//   l1Hits: 1234,
//   l2Hits: 56,
//   misses: 78,
//   l2Errors: 0,
//   l1HitRate: 0.9012,
//   overallHitRate: 0.9430,
//   l1Size: 234,
//   l1MaxSize: 1000,
// }
```

### Redis 内存使用
```bash
redis-cli INFO memory | grep used_memory_human
redis-cli --bigkeys           # 找出大 key
redis-cli SCAN 0 MATCH 'jerry:*' COUNT 100  # 列出本业务 key
```

### 排查降级
- 日志关键字：`Redis 错误`、`L2 读失败`、`L2 写失败`、`fail-open 放行`
- 频繁出现 → Redis 网络 / 实例问题
- 偶发出现 → 正常波动，不必处理

---

## 7. 未来演进路线

| 阶段 | 改造内容 | 触发条件 |
|------|---------|---------|
| 现状 | 单机 Redis + 全链路降级 | 现在 |
| Phase 1 | 加 watchdog 自动续期分布式锁 | 出现长时业务（> 5 分钟） |
| Phase 2 | 多级缓存加 singleflight 防击穿 | 热点 key 击穿现象明显 |
| Phase 3 | Redis 主从 + 哨兵 / Cluster | 用户数 > 1000 |
| Phase 4 | 引入 Redlock | 强一致性场景出现（如金融扣款） |

---

## 8. 面试速记

> 一句话总结：
>
> "我在项目里基于 Redis 设计了三层基础设施：**多级缓存（L1 LRU + L2 Redis）解决跨轮对话资产复用、滑动窗口限流防止 LLM 接口被刷、分布式锁解决同会话并发问题**。所有能力都做了 fail-open / fail-close 可配置的故障降级，Redis 挂了核心业务不受影响。"

可以聊深入的点（按面试官追问深度排序）：

1. **L1 LRU 实现**：`Map` 维持插入顺序，`delete + set` 实现"最近使用"标记
2. **TTL 抖动**：`ttlJitterRatio` 防雪崩，业内主流做法
3. **滑动窗口算法**：ZSET + ZREMRANGEBYSCORE + MULTI 原子事务
4. **Lua 脚本**：`GET == myValue then DEL` 保证锁释放原子性
5. **降级哲学**：fail-fast + offlineQueue=false + try/catch
6. **优雅关闭**：SIGTERM → app.close → redis.quit
7. **Key 命名**：业务前缀 + 冒号分隔 + 禁用 KEYS

每个点都能展开 5 分钟讲清楚原理 + 取舍。
