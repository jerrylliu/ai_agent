# 知识库文档版本管理方案

## 一、数据库层

1. 创建 `Document` 实体：id, title, description, tags, currentVersionId, createdAt, updatedAt
2. 创建 `DocumentVersion` 实体：id, documentId(外键), versionNumber(自增整数), fileUrl, fileSize, fileType, checksum(文件哈希), status(draft/active/archived), parsingStatus(pending/parsing/failed/success), errorMessage, chunkCount, uploadedBy, createdAt
3. 创建 `DocumentAuditLog` 实体：id, documentId, versionId, action(upload/activate/archive/rollback/delete), operator, detail, createdAt
4. 添加数据库索引：
   - `documentId + versionNumber` 联合唯一索引（防止并发冲突）
   - `status` 索引（加速按状态查询）
   - `createdAt` 索引（加速时间排序）
   - `parsingStatus` 索引（加速轮询解析进度）
5. 在 `app.module.ts` 中注册新实体到 TypeORM
6. 运行 TypeORM migration 生成建表语句

## 二、文件存储层

7. 修改文件上传目录结构：`uploads/documents/{documentId}/v{versionNumber}/`
8. 保留所有历史版本文件，不再覆盖同名文件
9. 创建文件清理服务：删除 archived 超过 N 天的版本文件
10. 上传时校验文件大小限制（如 50MB）和文件类型白名单（pdf/docx/txt/md/csv）
11. 上传时计算文件 checksum，与文档最新版本比对，相同则拒绝重复上传

## 三、后端 API 层

12. 创建 `DocumentController`，路由前缀 `/documents`，所有日志使用 Winston logger
13. 实现 `POST /documents/upload`：创建文档或新增版本，校验文件→计算checksum→存储文件→创建版本记录(parsingStatus=pending)→异步解析→切分→向量化→更新parsingStatus
14. 实现 `GET /documents`：列出所有文档（含最新版本信息）
15. 实现 `GET /documents/:id/versions`：列出某文档的所有版本
16. 实现 `GET /documents/:id/versions/:versionId`：获取特定版本详情
17. 实现 `GET /documents/:id/versions/:versionId/status`：轮询版本解析进度
18. 实现 `GET /documents/:id/versions/:versionId/download`：下载历史版本原文件
19. 实现 `PATCH /documents/:id/versions/:versionId`：修改版本状态（draft→active, active→archived）
20. 实现 `PUT /documents/:id`：修改文档标题/描述/标签等元信息
21. 实现 `POST /documents/:id/rollback`：回滚到指定版本（当前active→archived，目标版本→active，不创建新版本号，同步切换向量检索标记）
22. 实现 `DELETE /documents/:id/versions/:versionId`：删除特定版本（同时清理 ChromaDB 向量 + BM25 索引）
23. 实现 `DELETE /documents/:id`：删除整个文档（含所有版本文件 + 所有向量数据 + BM25 索引）
24. 实现 `GET /documents/:id/diff?v1=x&v2=y`：对比两个版本的文本差异（二进制文件先解析为纯文本再对比，超大文档截断或异步处理）
25. 实现 `GET /documents/:id/audit-log`：查询文档操作历史
26. 实现批量操作：`POST /documents/batch-archive`、`POST /documents/batch-delete`

## 四、向量存储层

27. 修改 `vector-store.ts` 的 `addDocuments()`：向每个 chunk 的 metadata 中注入 documentId、versionId、versionStatus
28. 修改 `searchKnowledgeBase()`：仅检索 versionStatus=active 的版本的向量
29. 创建 `removeDocumentVersion()` 方法：按 versionId 从 ChromaDB + BM25 索引中批量删除
30. 创建 `updateVersionVectorStatus()` 方法：按 versionId 批量更新向量的 versionStatus（回滚时用，不删除向量）
31. 创建 `reindexVersion()` 方法：先按 versionId 清理旧向量，再重新向量化入库（保证幂等）
32. 创建 `cleanOrphanVectors()` 方法：清理 ChromaDB 中存在但数据库无对应记录的孤岛向量

## 五、版本状态流转

33. 定义状态机：`draft → active → archived`，不允许逆向状态变更
34. 版本号策略：自增整数（v1, v2, v3...），简单清晰
35. 上传新版本时：自动将旧 active 版本改为 archived，新版本设为 active
36. 回滚操作：当前 active → archived，目标 archived → active，不创建新版本号，不修改原版本号
37. draft 状态的版本不参与 RAG 检索
38. parsingStatus 流转：pending → parsing → success/failed，failed 时记录 errorMessage

## 六、版本对比

39. 安装 `diff` 库用于文本差异计算
40. 解析两个版本的文件内容为纯文本（PDF/Word 等二进制文件先解析为文本）
41. 计算行级 diff，返回新增行/删除行/修改行
42. 超大文档（>1MB 纯文本）采用异步处理，返回任务 ID，前端轮询结果
43. 前端渲染 diff 结果（红绿高亮）

## 七、前端 UI 层

44. 创建 `DocumentManager` 组件：文档列表 + 版本时间线
45. 创建 `VersionTimeline` 组件：纵向时间线展示版本历史
46. 创建 `VersionDiff` 组件：左右对比或合并视图展示差异
47. 创建 `UploadDialog` 组件：上传时选择"新建文档"或"更新已有文档"，上传前预览文件内容
48. 修改知识库状态展示：显示文档数 + 活跃版本数 + 最近更新时间
49. 添加版本回滚按钮：确认弹窗 → 调用 API → 刷新列表
50. 添加版本下载按钮：下载历史版本原文件
51. 危险操作（删除版本、回滚）二次确认弹窗
52. 上传进度展示：解析中/向量化中/完成/失败，轮询 parsingStatus

## 八、审计日志

53. 每次版本变更操作时写入审计日志（使用 Winston logger 记录，同时写入数据库）
54. operator 字段处理：已登录用户取 userId，匿名用户标记为 `anonymous`
55. 审计日志保留期限策略：默认保留 180 天，超期自动清理
56. 实现 `GET /documents/:id/audit-log`：查询文档操作历史

## 九、数据一致性保障

57. 版本状态变更 + 向量状态标记 的补偿机制：先改数据库，再改向量，向量操作失败时写入重试队列
58. 重试队列：创建 `PendingVectorOp` 表（id, versionId, operation, status, retryCount, createdAt），定时任务扫描重试
59. 并发上传同一文档：数据库 `documentId + versionNumber` 唯一约束兜底，冲突时自增重试

## 十、定时任务

60. 创建定时任务：扫描 archived 超过 90 天的版本，仅通知管理员（不自动删除）
61. 创建定时任务：校验 ChromaDB 中向量数与数据库记录是否一致（数据一致性检查）
62. 创建定时任务：清理孤岛向量（ChromaDB 中有但数据库无记录的向量）
63. 创建定时任务：重试 PendingVectorOp 中失败的向量操作
64. 创建定时任务：清理超过 180 天的审计日志

## 十一、测试

65. 单元测试：版本状态流转逻辑
66. 单元测试：diff 计算准确性
67. 单元测试：checksum 重复上传拦截
68. 单元测试：并发上传 versionNumber 唯一约束
69. 集成测试：上传→检索→回滚→检索 完整流程
70. 集成测试：多版本并存时 RAG 只检索 active 版本
71. 集成测试：向量操作失败时重试队列补偿
72. 集成测试：删除文档时向量 + BM25 + 文件完整清理
