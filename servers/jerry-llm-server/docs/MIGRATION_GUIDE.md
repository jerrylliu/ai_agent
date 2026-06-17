# TypeORM Migration 工作流铁律备忘

> 适用范围：`servers/jerry-llm-server/`（NestJS 11 + TypeORM 0.3.x + MySQL）
>
> 本文沉淀自一次完整的"练习 → 踩坑 → 修复"实战，记录 5 条必须遵守的铁律，外加命令速查表与常见报错对照表。
> 后续遇到 Migration 问题时，**先查这份文档，再动手改代码**。

---

## 0. 前置约定

- 包管理器：**pnpm**（禁用 npm/yarn）
- 运行模式：**ESM**（`package.json` 的 `"type": "module"`）
- TypeORM CLI 入口：[typeorm-data-source.ts](../src/typeorm-data-source.ts) 编译产物 `dist/typeorm-data-source.js`
- 迁移文件目录：[src/migrations/](../src/migrations/)
- 业务运行时**不**加载 migrations，迁移仅通过 CLI 执行（见铁律 5）

---

## 1. 铁律一：迁移类名时间戳必须 13 位

### 现象
```
Error: Migration name is wrong. Migration class name should have a JavaScript timestamp appended.
```

### 错误示例
```ts
// ❌ 类名末尾是 10 位（秒级时间戳）
export class ReactivateInactiveUsers1782000000 implements MigrationInterface {
  name = 'ReactivateInactiveUsers1782000000';
}
```

### 正确写法
```ts
// ✅ 类名末尾必须 13 位（毫秒级时间戳，对应 Date.now()）
export class ReactivateInactiveUsers1782000000001 implements MigrationInterface {
  name = 'ReactivateInactiveUsers1782000000001';
}
```

### 原理
TypeORM 用正则解析类名末尾的连续数字，作为 `migrations` 表中的 `timestamp` 字段。
该字段决定执行顺序与幂等判断，长度必须与 `Date.now()` 一致（13 位）。

### 大白话
TypeORM 看你尾巴上的数字不到 13 位，就觉得"这不是一个合格的时间戳"，直接拒绝执行。

---

## 2. 铁律二：UPDATE / DELETE / INSERT 的返回值不可数组解构

### 现象
```
TypeError: (intermediate value) is not iterable
```

### 错误示例
```ts
// ❌ UPDATE 返回的是单对象，不是数组，不能解构
const [result] = await queryRunner.query(
  `UPDATE users SET isActive = 1 WHERE isActive = 0`,
);
```

### 正确写法
```ts
// ✅ 直接接收单对象，从 affectedRows 取值
const result: any = await queryRunner.query(
  `UPDATE \`users\` SET \`isActive\` = 1 WHERE \`isActive\` = 0`,
);
console.log(`Reactivated ${result.affectedRows} users`);
```

### 返回值速查
| SQL 类型 | 返回值结构 | 取值方式 |
|----------|------------|----------|
| `SELECT` | `RowDataPacket[]`（数组） | `const rows = await query(...)` 或 `const [first] = await query(...)` |
| `INSERT` | `ResultSetHeader`（单对象） | `result.insertId`、`result.affectedRows` |
| `UPDATE` | `ResultSetHeader`（单对象） | `result.affectedRows`、`result.changedRows` |
| `DELETE` | `ResultSetHeader`（单对象） | `result.affectedRows` |

### 大白话
- `SELECT` 是去仓库"取一摞货"，所以是数组；
- `UPDATE/DELETE/INSERT` 是给仓库"递了一张回执单"，所以是单个对象。
- 用 `[result]` 解构非数组对象，JS 找不到 `Symbol.iterator`，直接报"不可迭代"。

---

## 3. 铁律三：删字段必须走"两段式"（Expand-and-Contract）

### 错误流程（一步到位 = 灾难）
```
Entity 删字段 + DROP COLUMN  →  上线  →  旧版本应用查询炸 + 编译报错
```

### 正确流程
**Phase 1（代码侧先发布）**
1. 在所有使用方注释 / 删除该字段的引用
   - Service 层（如 [auth.service.ts](../src/auth/auth.service.ts)）
   - 单测（如 `auth.service.spec.ts`、`auth.controller.spec.ts`）
   - DTO / Controller / Hook
2. **Entity 字段保留** → 上线 → 观察一段时间，确认无回滚需求

**Phase 2（数据库侧再发布）**
3. Entity 删字段
4. `pnpm migration:generate -- src/migrations/RemoveXxxField`
5. `pnpm migration:run` → 真正 DROP COLUMN

### 大白话
先让代码"假装这个字段不存在"，跑稳了再真删数据库列，避免新旧版本混跑时一边还在写、另一边已经把列删了的尴尬。

### 专业术语
**Zero-downtime schema migration** 的标准模式 —— Expand and Contract Pattern，确保任意时刻"运行中的代码"与"数据库 schema"都兼容。

---

## 4. 铁律四：加 NOT NULL 字段必须走"三步法"

### 危险写法
```ts
// ❌ 直接在 Entity 上加非空字段
@Column({ type: 'varchar', length: 50, nullable: false })
nickname!: string;
```

如果生产 MySQL 开启了 `STRICT_TRANS_TABLES`（推荐配置），现有行没有默认值会**直接报错回滚**。
本机练习没翻车是因为本地 sql_mode 宽松，会静默填空字符串 —— **不要被骗**。

### 正确三步法

**Step 1：先加 NULL 字段**
```ts
@Column({ type: 'varchar', length: 50, nullable: true })
nickname?: string;
```
→ generate → run

**Step 2：写一个数据迁移回填**
```ts
public async up(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(
    `UPDATE \`users\` SET \`nickname\` = \`username\` WHERE \`nickname\` IS NULL`,
  );
}
```

**Step 3：改为 NOT NULL**
```ts
@Column({ type: 'varchar', length: 50, nullable: false })
nickname!: string;
```
→ generate → run（此时 MODIFY COLUMN 安全执行）

### 大白话
表里已经有几百万行老数据，你突然加一列"必须填"的字段，老数据填啥？必须先允许空，再批量补，再改成必填。

---

## 5. 铁律五：Migration 与 NestJS 运行时彻底解耦

### 错误配置
```ts
// ❌ 在 app.module.ts 里加载迁移文件
TypeOrmModule.forRoot({
  migrations: [__dirname + '/migrations/*.{js,ts}'],
  migrationsRun: true,
});
```

启动时报错：
```
Unexpected module status 0
SyntaxError: The requested module '...' does not provide an export named 'MigrationInterface'
```

### 正确配置
```ts
// ✅ app.module.ts 留空，业务运行时不碰迁移
TypeOrmModule.forRoot({
  entities: [...],
  synchronize: config.db.synchronize, // 生产固定 false
  migrations: [],
  migrationsRun: false,
});
```

迁移**只**通过 CLI 走 [typeorm-data-source.ts](../src/typeorm-data-source.ts)：
```ts
const AppDataSource = new DataSource({
  type: 'mysql',
  ...
  entities: [__dirname + '/entities/*.entity.js'],
  migrations: [__dirname + '/migrations/*.{js,ts}'],
  synchronize: false,
});
```

### 原理
NestJS 11 是 ESM，TypeORM 在 `forRoot` 阶段使用同步 `require()` 加载 migrations 路径下的模块，
对 ESM 的 `.ts` 源文件无能为力（ts-node loader 无法注入到同步 require 流程）。

### 大白话
让 NestJS 启动时**完全无视**迁移文件，迁移这种"修房子"的事统一交给 CLI，业务代码只管"住房子"，互不打扰。

---

## 6. 命令速查表

| 命令 | 大白话 | 专业术语 |
|------|--------|----------|
| `pnpm build` | 把 TS 编译成 JS 丢到 dist/ | TypeScript transpile |
| `pnpm migration:generate -- <path>` | 对比代码 vs 数据库，自动写迁移 | Schema diff → DDL generation |
| `pnpm migration:run` | 按时间戳顺序执行未跑的迁移 | 调用未执行 migration 的 `up()` |
| `pnpm migration:revert` | 回滚最近一次迁移 | 调用最近一条 migration 的 `down()` |
| `pnpm migration:show` | 列出所有迁移与执行状态 | 对比 `migrations` 表 vs 文件系统 |
| `$env:DB_DATABASE='xxx'` | PowerShell 临时切库（仅当前会话） | session-scoped env override |

---

## 7. 常见报错对照表

| 报错信息 | 根因 | 对应铁律 |
|----------|------|----------|
| `Migration name is wrong. ... should have a JavaScript timestamp` | 类名时间戳不是 13 位 | 铁律 1 |
| `(intermediate value) is not iterable` | UPDATE/DELETE/INSERT 用了数组解构 | 铁律 2 |
| `Property 'xxx' does not exist on type 'User'` | 删字段没走两段式，代码先于 Entity 失去引用 | 铁律 3 |
| `Field 'xxx' doesn't have a default value` | 加 NOT NULL 没走三步法 + sql_mode 严格 | 铁律 4 |
| `Unexpected module status 0` / `does not provide an export named 'MigrationInterface'` | NestJS 启动时同步加载 ESM .ts 迁移文件 | 铁律 5 |
| `pnpm migration:generate ... 无法识别的选项` | `package.json` 脚本里硬编码了路径，与 CLI 传参冲突 | 见下方"附录" |

---

## 8. 安全演练流程（不污染主库）

```powershell
# 1. 切独立分支
git checkout -b practice/migration-workflow

# 2. 切独立数据库（仅当前 PowerShell 会话生效）
$env:DB_DATABASE='cyberpunk_migration_practice'

# 3. 在 MySQL 里建练习库
#   CREATE DATABASE cyberpunk_migration_practice;

# 4. 随便玩，玩崩了直接：
git checkout main
git branch -D practice/migration-workflow
#   DROP DATABASE cyberpunk_migration_practice;
```

---

## 9. 附录：`package.json` 脚本配置范本

```jsonc
{
  "scripts": {
    "typeorm": "typeorm -d dist/typeorm-data-source.js",
    "migration:generate": "pnpm build && pnpm typeorm migration:generate",
    "migration:run":      "pnpm build && pnpm typeorm migration:run",
    "migration:revert":   "pnpm build && pnpm typeorm migration:revert",
    "migration:show":     "pnpm build && pnpm typeorm migration:show"
  }
}
```

> ⚠️ **不要**在 `migration:generate` 里硬编码迁移文件路径，路径必须由调用方通过
> `pnpm migration:generate -- src/migrations/<Name>` 传入，否则会与用户参数冲突。

---

## 10. 修改本文档的原则

- 每次踩到新坑，**修复后立即回填**到本文，避免下次重复踩。
- 报错信息原文照抄到「常见报错对照表」，方便日后用关键字搜索。
- 大白话与专业术语并列，应对"快速回忆"和"团队沟通"两种场景。










toolName: CompactFake
            
status: success
          
          
收到。本次任务是对前面 Migration 工作流练习做一份"复盘总结"，不涉及代码生成、UI 设计、调试运行、安全审查等需要技能加持的场景，因此 `<available_skills>` 中没有匹配的 skill 需要调用，直接进行总结输出。

---

# Migration 工作流实践 · 全流程复盘总结

> 本次练习基于 `practice/migration-workflow` 分支 + `cyberpunk_migration_practice` 独立数据库，做到"沙盒隔离、可一键回滚"。下面按"执行了什么 → 改了什么 → 错在哪 → 怎么修"四段拆解，每段给"大白话"+"专业术语"两版解释。

---

## 一、整体准备阶段

### 执行的命令
```powershell
git checkout -b practice/migration-workflow
$env:DB_DATABASE='cyberpunk_migration_practice'
# 创建一个干净的练习数据库，不污染主库
```

### 含义
- **大白话**：开了一个"小号分支" + "小号数据库"，所有练习全在小号里玩，玩崩了直接删，主项目毫发无伤。
- **专业术语**：通过 Git feature branch 隔离代码变更，通过 PowerShell session-scoped 环境变量覆写 `DB_DATABASE`，实现 schema/data 的环境隔离（sandbox isolation），确保练习不污染 production-like 主数据库。

---

## 二、场景 0：生成 Baseline（InitialSchema）

### 执行
```powershell
pnpm migration:generate -- src/migrations/InitialSchema
```

### 含义
- **大白话**：让 TypeORM 把"现在 17 张表的样子"拍一张照片存成迁移文件，作为后续所有改动的"起点快照"。
- **专业术语**：基于当前 Entity 元数据 (`EntityMetadata`) 与目标库 schema 的 diff，生成 baseline migration（DDL：CREATE TABLE × 17 + ADD FOREIGN KEY × 4），后续所有变更都在此快照之上做增量演进。

### 关键修复点
- [package.json](file:///e:/miaoma-ai-app/servers/jerry-llm-server/package.json) 里 `migration:generate` 脚本原本硬编码了 `src/migrations/InitialSchema`，导致用户传参变成"两个名字"冲突 → **修复**：脚本去掉硬编码，改为完全由 CLI 传参。

---

## 三、场景 1：加普通字段（AddUserNickname）

### 执行
1. 在 [user.entity.ts](file:///e:/miaoma-ai-app/servers/jerry-llm-server/src/entities/user.entity.ts) 加 `nickname: string` 字段
2. `pnpm migration:generate -- src/migrations/AddUserNickname`
3. `pnpm migration:run`

### 含义
- **大白话**：先在"实体类"里写好新字段，TypeORM 帮你对比"代码里的字段 vs 数据库里的字段"，自动生成 `ALTER TABLE ADD COLUMN` 语句，再一键执行到库里。
- **专业术语**：声明式 schema 演进 —— Entity 是 Source of Truth，TypeORM 通过 schema diff 生成增量 DDL，迁移文件 `up()` 持久化变更，`down()` 提供回滚路径。

### 教学要点
本次没翻车（即使加了 NOT NULL 字段），是因为本机 MySQL 未开 `STRICT_TRANS_TABLES`，会静默把新行填空字符串。生产环境务必走"三步法"：
1. ADD COLUMN NULL
2. UPDATE 回填
3. MODIFY NOT NULL

---

## 四、场景 2：改字段类型（ChangeContentToMediumText）

### 执行
- TEXT → MEDIUMTEXT（容量从 64KB 提升到 16MB）

### 含义
- **大白话**：原来一条聊天内容最多存 64KB，怕长文档塞不下，扩到 16MB。
- **专业术语**：列类型变更（column type alteration），MySQL 会执行 in-place 或 copy 算法重建列存储；MEDIUMTEXT 在大文本场景下避免 `Data too long for column` 异常。

---

## 五、场景 3：删字段（RemoveUserAvatar）—— 两段式

### 执行
**第一阶段（先发布"代码不再使用 avatar"）**
- 注释 [auth.service.ts](file:///e:/miaoma-ai-app/servers/jerry-llm-server/src/auth/auth.service.ts#L163-L169) 中所有 `user.avatar = ...` 的逻辑
- 同步修改 [auth.service.spec.ts](file:///e:/miaoma-ai-app/servers/jerry-llm-server/src/auth/auth.service.spec.ts) 与 [auth.controller.spec.ts](file:///e:/miaoma-ai-app/servers/jerry-llm-server/src/auth/auth.controller.spec.ts)

**第二阶段（再发布 DROP COLUMN 迁移）**
- Entity 删字段 → generate → run

### 报错 & 修复
```
Property 'avatar' does not exist on type 'User'
```
- **大白话**：Entity 里把 `avatar` 删了，但 service 和测试代码里还在用，TypeScript 立马翻脸。
- **专业术语**：删字段必须遵循 **expand-and-contract pattern**（双段发布）：
  1. **Contract phase 1（代码侧）**：先在所有使用方移除引用，Entity 字段保留 → 上线 → 确认无回滚需求
  2. **Contract phase 2（数据库侧）**：再 DROP COLUMN → 上线
- 反之直接删字段会导致旧版本应用查询失败 + 编译报错，违反 zero-downtime 原则。

---

## 六、场景 4：手写数据迁移（ReactivateInactiveUsers）—— 报错重灾区

### 文件 [1782000000-ReactivateInactiveUsers.ts](file:///e:/miaoma-ai-app/servers/jerry-llm-server/src/migrations/1782000000-ReactivateInactiveUsers.ts)

### 报错 1：`Migration name is wrong. Migration class name should have a JavaScript timestamp appended`
- **大白话**：TypeORM 看类名后缀是 10 位数字，骂你"这不是 JS 时间戳，至少要 13 位"。
- **专业术语**：TypeORM 通过正则解析类名末尾的数字作为 `timestamp` 字段（用于排序与幂等判断），要求长度匹配 `Date.now()` 的毫秒级时间戳（13 位）。修复：`1782000000` → `1782000000001`。

### 报错 2：`(intermediate value) is not iterable`
原代码：
```ts
const [result] = await queryRunner.query(`UPDATE users SET isActive = 1 WHERE isActive = 0`);
```
修复后：
```ts
const result: any = await queryRunner.query(
    `UPDATE \`users\` SET \`isActive\` = 1 WHERE \`isActive\` = 0`
);
console.log(`Reactivated ${result.affectedRows} users`);
```

- **大白话**：`SELECT` 查出来的是"一排数据"（数组），可以解构；`UPDATE` 返回的是"一份小报表"（单个对象 `{affectedRows, ...}`），不能用 `[result]` 这种数组解构语法去拆，所以 JS 报"不可迭代"。
- **专业术语**：mysql2 driver 对不同 SQL 语义返回值不同：
  - `SELECT` → `RowDataPacket[]`（可迭代数组）
  - `INSERT/UPDATE/DELETE` → `ResultSetHeader`（含 `affectedRows`、`insertId`、`changedRows` 等元信息的单对象）
  
  数组解构 `const [x] = obj` 触发 `Symbol.iterator` 调用，普通对象无此协议 → `TypeError: ... is not iterable`。

---

## 七、贯穿始终的"环境/运行"问题

### 问题：NestJS 启动崩溃 `Unexpected module status 0` / `MigrationInterface 命名导出缺失`
- **大白话**：NestJS 启动时想加载迁移文件，结果迁移文件是 `.ts` 又是 ESM 风格，加载方式不兼容直接崩。
- **专业术语**：NestJS 11 运行于 ESM 模式（`"type": "module"`），TypeORM 在 `forRoot` 阶段使用 `require()` 同步加载 migrations 路径下的模块，对 ESM 的 `.ts` 源文件无能为力（ts-node loader 无法注入到 sync require 流程）。
- **修复**：[app.module.ts](file:///e:/miaoma-ai-app/servers/jerry-llm-server/src/app.module.ts) 里 `migrations: []` 留空，迁移**只通过 CLI 走 [typeorm-data-source.ts](file:///e:/miaoma-ai-app/servers/jerry-llm-server/src/typeorm-data-source.ts) 编译后的 dist/*.js 执行**，业务运行时不再加载 migration 文件，彻底解耦。

---

## 八、命令速查表（带白话注解）

| 命令 | 大白话 | 专业术语 |
|------|--------|----------|
| `pnpm build` | 把 TS 编译成 JS，丢到 dist/ | TypeScript transpile，输出 CommonJS/ESM 产物供 Node 运行 |
| `pnpm migration:generate -- <path>` | 让 TypeORM 对比代码和数据库，自动写迁移文件 | Schema diff → DDL generation |
| `pnpm migration:run` | 把还没跑过的迁移按时间戳顺序全部执行 | 按 `migrations` 表记录的已执行集合，执行未执行的 `up()` |
| `pnpm migration:revert` | 回滚最近一次迁移（执行 down()） | 弹出最近一条 migrations 记录，执行其 `down()` |
| `pnpm migration:show` | 列出所有迁移 + 是否已执行 | 列出 migrations 表 vs 文件系统差集 |
| `$env:DB_DATABASE='xxx'` | PowerShell 临时改环境变量，仅当前会话生效 | session-scoped env override |

---

## 九、本次练习沉淀的 5 条铁律

1. **类名时间戳 13 位** —— 否则 TypeORM 不认。
2. **UPDATE/DELETE/INSERT 的返回值不能数组解构** —— 用 `result.affectedRows`。
3. **删字段两段式** —— 先去代码引用，再 DROP COLUMN。
4. **加 NOT NULL 三步法** —— ADD NULL → UPDATE 回填 → MODIFY NOT NULL，别赌 sql_mode。
5. **Migration 与 NestJS 运行时解耦** —— `app.module.migrations: []`，全部走 CLI + `dist/*.js`。

---

练习完成后，回归原始状态只需：
```powershell
git checkout main
git branch -D practice/migration-workflow
# 然后 MySQL 里 DROP DATABASE cyberpunk_migration_practice;
```
主项目和主数据库不会留下任何痕迹。