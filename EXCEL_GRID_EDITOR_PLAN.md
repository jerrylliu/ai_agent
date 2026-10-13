# Excel 网格化编辑方案（AI 编辑器 × 表格编辑 × xlsx 回写）

> 目标：用户上传 Excel → 在 AI 编辑器里以**真表格网格**编辑 → 保存为新版本（不进向量库）→ 下载得到修改后的 `.xlsx` 文件。
>
> 本方案为评审稿，确认后按 M1 范围实施。

---

## 一、现状与差距（已逐文件查实）

| 环节 | 现状 | 差距 |
|---|---|---|
| 上传 Excel | 聊天框/编辑器上传走 `/upload/extract`，服务端 [document-parser.ts](servers/jerry-llm-server/src/fundamentals/document-parser.ts#L572) 用 SheetJS 把每个 sheet 转成 `Sheet: 名称` + CSV 文本 | 无 |
| 编辑器形态 | [DocumentEditorPage](clients/jerry-ai-app/src/pages/DocumentEditorPage.tsx) 基于 Tiptap 3 富文本，Excel 内容进来是 **CSV 纯文本段落**，逗号满天飞 | 无法按单元格编辑 |
| 表格能力 | Tiptap StarterKit **不含 table 扩展**（package.json 无 `@tiptap/extension-table`） | 需新增依赖 |
| 保存链路 | `PUT /documents/:id/content`（contentJson + contentText），草稿按文件名建文档/新版本，**不自动入向量库** | 零改动 |
| 下载产物 | 保存产生 `.md` 文本版本；原 `.xlsx` 二进制只在第一版 | 改完拿不到 Excel 文件 |

**结论**：差三块——表格扩展、CSV↔表格转换层、xlsx 导出。其余全部现成。

---

## 二、三个关键设计决策

### D1：表格的存储形态 = Tiptap table 节点，contentText 仍是 CSV

- `contentJson` 里存 Tiptap 原生 `table / tableRow / tableCell` 节点（编辑器可直读直写）；
- `contentText`（给 RAG/发布/全文搜索用的纯文本）仍由现有逻辑生成——表格节点会自然序列化成文本行，**检索链路零回归**；
- 不引入"Excel 私有 JSON 格式"，文档系统不需要知道"这是一份 Excel"。

### D2：CSV→表格转换放前端，xlsx 导出放后端

- **转换层在前端**（打开文档时 CSV 文本 → 表格节点）：转换是纯展示层逻辑，前端做可以按需懒转换、保留撤销栈一致性；
- **xlsx 导出在后端**（新下载参数 `?format=xlsx`）：服务端已有 `xlsx` 依赖，从 `contentText` 的 CSV 重新组装 workbook 写出二进制；**避免给前端 bundle 加约 400KB 的 SheetJS**（桌面端安装包体积敏感）；
- 多 sheet 用现有 `## Sheet: 名称` 标题自然分段：导入时每个 CSV 块转一张表，导出时按标题拆回多个 sheet。

### D3：向量库链路完全不动

已确认 [document.service.ts](servers/jerry-llm-server/src/services/document.service.ts#L406) 的既定行为：编辑器保存只建版本，**发布到知识库必须用户手动点**。本特性沿用该行为，零改动、零风险。

---

## 三、M1 实施范围（本次）

### 步骤 1：前端接入 Tiptap 表格扩展（需您执行一条安装命令）

```bash
pnpm --filter jerry-ai-app add @tiptap/extension-table
```

> ⚠️ 按工程规范不凭空引入依赖，此命令由您执行。Tiptap 3 的 table 包内含 Table/TableRow/TableHeader/TableCell 一组节点（TableKit）。

改动文件：
- [DocumentEditor.tsx](clients/jerry-ai-app/src/components/Editor/DocumentEditor.tsx)：注册 TableKit；
- [EditorToolbar.tsx](clients/jerry-ai-app/src/components/Editor/EditorToolbar.tsx)：表格操作组——插入表格、增/删行列、切换表头行（用 lucide 图标，风格对齐现有按钮）。

### 步骤 2：前端转换层（新建 `src/lib/table-convert.ts`）

- `csvTextToTableNodes(csv: string)`：支持引号转义单元格（`"a,b"`、换行），首行默认为表头；
- `tableNodesToCsv(tables)`：反向序列化（导出前自检用）；
- 打开文档时判定"这是 xlsx 来源"→ 按 `## Sheet: x` 标题拆段 → 每段 CSV 转表格节点，标题保留为 heading（sheet 分段线索不丢）。

**来源判定**：`/upload/extract` 的返回已有 fileName/mimetype；补充一个 `sourceFormat: 'xlsx'` 字段（步骤 3），编辑器拿到后走表格化渲染；打开**历史旧文档**（无该标记但内容以 `## Sheet:` 开头）做启发式兜底，识别不了就维持现状纯文本——**宁可不转，不可转坏**。

### 步骤 3：后端两处小改

1. [document-parser.ts](servers/jerry-llm-server/src/fundamentals/document-parser.ts)：`ParsedDocument` 增加 `sourceFormat`、`sheetNames` 元数据（纯新增字段，不影响现有消费方）；
2. 下载接口支持 `?format=xlsx`：读最新（或指定）版本 `contentText` → 按 sheet 标题拆 CSV → `XLSX.utils.book_new + aoa_to_sheet + write` → 输出真 `.xlsx`。复用现有版本下载的鉴权与流式响应，不新增表、不新增实体。

### 步骤 4：下载入口 UI + 保存链路确认

- 编辑器/文档列表的下载按钮：xlsx 来源文档显示"下载 Excel / 下载 Markdown"两个选项；
- 保存：完全走现有 `saveDocumentContent` / 草稿保存，**不碰**（D3）。

### M1 明确不做（防蔓延）

- 不做公式实时重算（M2 公式透传：打开文件时由真 Excel 引擎重算，见第六节）；
- 不做合并单元格（Tiptap table 无此概念，原文件合并单元格会被展开为普通格）；
- 不做 AI 直接改表格结构（AI 面板对选中文本的改写天然可用，属既有能力）；
- **撤销/重做 M1 即可用**：Tiptap 历史栈天然覆盖单元格编辑（改一格 Ctrl+Z 即回退），零额外成本。不做的是单元格样式美化——SheetJS 社区版不支持写样式，M2 换 exceljs 后解锁。

---

## 四、风险与边界（诚实清单）

> 2026-10-13 修订：撤销/重做纳入 M1（Tiptap 历史栈天然覆盖单元格编辑，零成本）；公式透传、单元格样式、大表 AI 指令下推列入 M2 路线图（见第六节）；500 行只读阈值方案废弃，改为性能警告 + 保险丝。

| 风险 | 等级 | 处理 |
|---|---|---|
| **公式丢失** | 既成事实 | M1 编辑的是"值快照"（解析层只取值）。公式透传列 M2：存 `cell.f` + 缓存值，导出写回并强制打开时全量重算，公式格加视觉标记 |
| **单元格样式** | 低 | SheetJS 社区版不支持写样式（Pro 付费功能），做了也导不出去——M2 换 `exceljs`（MIT、样式完整）做导出层后解锁 |
| **类型变形** | 中 | CSV round-trip 后数字靠导出时类型推断恢复；**日期最易变形**（可能变字符串）。M1 接受，M2 可在 contentJson 节点 attr 里存单元格原始类型 |
| **大表性能** | 中 | Tiptap 每个单元格是独立节点，3000 行 × 10 列 ≈ 3 万节点会卡死。M1 策略：**≤500 行完全无感；500~2000 行弹性能警告但完全可编辑；>2000 行触发保险丝（只读 + 引导，M2 用 AI 指令下推彻底消灭只读）**。保险丝数值以真实大表压测校准为准 |
| **转坏数据** | 中 | 转换层带双向自检：转换后立即序列化回 CSV 与原文比对，行数/列数不一致则放弃表格化、降级纯文本 |
| **旧文档误判** | 低 | 启发式兜底识别不了就维持纯文本，不强制 |
| **RAG/发布回归** | 低 | contentText 生成逻辑不变，表格文本照常可检索 |

---

## 五、验证清单（M1 完成后人工测试）

1. 上传多 sheet Excel → 打开编辑器 → 每个sheet 是独立表格、首行为表头；
2. 改单元格数值、加一行、删一列 → 保存 → 刷新后内容保持；
3. 下载 Excel → 用 Excel/WPS 打开：sheet 数量、表头、修改值正确；数字列是数字不是文本；
4. 全程检查"我的记忆与摘要/知识库"确认**未产生新向量数据**；
5. 对表格选中文本用 AI 改写 → 正常生效；
6. 上传含合并单元格/公式的 Excel → 不崩溃（合并展开、公式为值），下载可打开；
7. 旧的非 Excel 文档打开 → 与改动前行为完全一致（回归确认）。

## 六、M2 路线图（按优先级）

1. **大表 AI 指令下推**：大表不靠手点单元格，一句话让服务端用 SheetJS 直接改文件（"删掉 B 列为空的行""第 3000 行数量改成 5"），编辑器只渲染预览——对大表这是正确交互范式，彻底消灭只读保险丝；
2. **公式透传**：解析时存 `cell.f` + 缓存值 → 导出写回 + 强制"打开时重算"（真 Excel 引擎重算），编辑器内不重算但打开文件后数据永远新鲜；公式单元格视觉标记防误读；
3. **导出层换 exceljs**：解锁单元格样式（底色/边框/字体），同时获得更可靠的类型写入；
4. **单元格类型保真**：contentJson 节点 attr 存原始类型（number/date/percent），消除日期变形。

## 七、部署注意

- 后端：纯代码变更，照常三条服务器命令；
- 前端：**涉及新依赖与编辑器核心，需重新打包 exe + APK 并更新官网**（届时按 DEPLOYMENT_INFO.md 流程走，版本号 +1）。
