# KG A 档实体链接命中率 spike 报告（30 题）

生成时间：2026-09-23T05:06:11.587Z　模型：deepseek:deepseek-v4-flash　LLM 采样 seed：20260923（换 seed 复跑）

## 预注册修正声明（⚠️ 必读，防 p-hacking）

**本节承认：判定线是在看到 10 题两轮数据之后修改的，属事后改判据，存在 p-hacking 风险。**

- 原 v1 判定线（**已作废**）：PASS ⇔ linkRate ≥ 0.6 且 提升题数 ≥ 2 且 回退 ≤ 提升；REJECT ⇔ linkRate < 0.3。
- 作废时间点：10 题两轮 linkRate（首轮 55.9% / seed2 轮 50.8%，均值 53.4%）出来**之后**、30 题门闩开跑**之前**。
- 作废原因：linkRate 的分母混入了「表述根本没在 gold 正文出现」的不可链接 mention（两轮实测占分母 34% / 41%）。这类 mention 的**正确行为就是不链接**，因此 linkRate 的数学天花板只有约 66.0%，0.6 的 PASS 线在该口径下几乎不可达——瓶颈是**指标分母污染**，不是链接能力不足（剔除污染后的可链接子集命中率两轮合并为 85.1%）。
- 数据保全：两轮原始 linkRate、逐 mention 链接明细、未链接归因全部保留在各自 `spike-data.json` 中，未删未改；本报告同时输出 v1 口径下的判定结果（`legacyVerdict = REVIEW`）作为留痕对照。
- 修正约束：为降低事后调线的自由裁量空间，修正只做了**一次**，且在 30 题门闩数据产生**之前**由用户明确批准；30 题门闩一律**单轮固定 --seed 20260923**，不再多轮换 seed 择优。

## 判定线（v3 修正版，当前生效）

- **主判据**：提升题数 / headroom ≥ 0.5。headroom = 基线 R@3 未满（< 1.0）的题数，是提升题数的**数学上限**；不同轮选题的基线难度不同，故必须按 headroom 归一，「提升 ≥ N 题」这种绝对数不可比。
- **安全判据**：回退题数 ≤ 提升题数，且 回退题数 ≤ 1（30 题口径约 5%）。
- **兜底判据**：可链接子集命中率 ≥ 0.5（低于此值说明链接层本身崩坏，检索端结论不可信）。
- REJECT：提升题数 = 0，或 回退 > 提升。REVIEW：主/安全/兜底任一不满足。其余 PASS。
- **linkRate（主口径 + 严格口径）降为诊断指标，不设门**——理由见上方修正声明。
- 归因口径：merged = baseline top2 + 图补充 1 位（补充位最多顶 1 个，最多翻 1 题，不夸大）。

## 判定结论：✅ PASS

| 指标 | 值 | 判定线 | 是否满足 |
|------|-----|--------|----------|
| **提升题数 / headroom（主判据）** | **6 / 12 = 50.0%** | ≥ 0.5 | ✅ |
| 回退题数（安全判据） | 0 | ≤ 提升（6）且 ≤ 1 | ✅ |
| 可链接子集命中率（兜底判据） | 80.5%（107/133） | ≥ 0.5 | ✅ |
| v1 口径判定（留痕对照，不参与定档） | REVIEW | — | — |

### 全量指标（含诊断项）

| 指标 | 值 |
|------|-----|
| 基线 R@3 | 60.0% |
| merged R@3（补 1 位） | 80.0%（Δ 20.0%） |
| 纯图排序 R@3 | 80.0% |
| headroom（基线 R@3 未满的题数） | 12 / 30 |
| 提升 / 回退题数 | 6 / 0 |
| 新增可达 gold（基线 top10 未召回、图池命中） | 1 |
| 〔诊断〕linkRate（micro，conf ≥ 0.6） | 57.8%（107/185） |
| 〔诊断〕严格口径 linkRate（conf ≥ 0.85，与 v1 二元确认可比） | 24.3%（45/185） |
| 〔诊断〕不可链接 mention（表述不在 gold 正文，已从兜底判据分母剔除） | 52 / 185（28.1%） |
| 〔诊断〕题目级命中率（≥1 mention 链接成功） | 100.0% |
| 〔诊断〕纯精确归一化匹配率（不含 LLM 链接） | 15.7% |

## headroom 逐题归因（PASS 压线的稳健性核验）

> 主判据 **6 / 12 = 50.0% 正好压线**（1 题 ≈ 8.3%），必须逐题核验这个 PASS 是否站得住。
> 数据源：`spike-data.json` 的 `perQuestion`，脚本 `gate30-analyze.cjs` 复核。

| qid | 基线R@3 | mergedR@3 | 纯图R@3 | 图池 | 链接密度 | 归因 |
|-----|---------|-----------|---------|------|----------|------|
| qst_0178 | 0% | **100%** | 100% | 4 | 3/3 (100%) | ✅ 翻中 |
| qst_0184 | 0% | **100%** | 100% | 13 | 4/5 (80%) | ✅ 翻中 |
| qst_0186 | 0% | 0% | **100%** | 10 | 6/8 (75%) | ⚠️ 图池**有** gold，1 个补充位不够 |
| qst_0187 | 0% | 0% | 0% | **1** | 1/7 (14%) | ❌ 链接密度过低 → 图池仅 1 条，必然捞不到 |
| qst_0191 | 0% | 0% | **100%** | 5 | 4/8 (50%) | ⚠️ 图池**有** gold，1 个补充位不够 |
| qst_0193 | 0% | **100%** | 100% | 3 | 3/5 (60%) | ✅ 翻中 |
| qst_0197 | 0% | 0% | 0% | 4 | 3/6 (50%) | ❌ 链接密度尚可，属图结构/跳数未覆盖 gold |
| qst_0200 | 0% | 0% | 0% | 4 | 3/4 (75%) | ❌ 链接密度高，属图结构/跳数未覆盖 gold |
| qst_0201 | 0% | **100%** | 100% | 6 | 4/8 (50%) | ✅ 翻中（**唯一**新增可达 gold） |
| qst_0203 | 0% | **100%** | 100% | 14 | 5/8 (63%) | ✅ 翻中 |
| qst_0204 | 0% | 0% | 0% | **2** | 1/5 (20%) | ❌ 链接密度过低 → 图池仅 2 条，必然捞不到 |
| qst_0205 | 0% | **100%** | 100% | 2 | 6/8 (75%) | ✅ 翻中 |

### 三类结论

**① PASS 成立，且例外条款不触发。** 本轮局限第 7 条写的降级条件是「提升数刚好压线**且回退 = 提升**」；实测回退 = 0 ≠ 提升 = 6，例外不触发，PASS 有效。

**② 50.0% 是保守归因口径下的下限，不是能力上限。** qst_0186 / qst_0191 的纯图 R@3 = 100%，说明图池里**确实有 gold**，只是「基线 top2 + 图补 1 位」的口径给不出第 2 个位置。若补充位放到 2 个（仍不动基线 top1），可翻中上限 ≈ **8 / 12 = 66.7%**。这是上限而非实测——图池排序未必能把 gold 排进前 2，需重跑验证。

**③ 未翻中的 6 题分三类，根因不同、修法不同：**

| 类别 | 题数 | 题 | 特征 | 修法 |
|------|------|-----|------|------|
| ⚠️ 图池**已有** gold，仅补充位不够 | 2 | qst_0186、qst_0191 | 纯图 R@3 = 100%，但 merged = 0% | 补充位 1 → 2（不动基线 top1）即可望翻中 |
| ❌ 链接召回不足 | 2 | qst_0187、qst_0204 | 链接密度 14% / 20%，图池仅 1~2 条 | 提 mention 抽取质量与候选池 top-K |
| ❌ 图结构未覆盖 gold | 2 | qst_0197、qst_0200 | 链接密度 50% / 75%，图池 4 条仍无 gold | 加跳数或改进「关联 chunk」扩边策略 |

→ **链接密度与翻中强相关**：6 道翻中题密度中位数 **69%**（50/60/63/75/80/100）；6 道未翻中题中位数 **50%**（14/20/50/50/75/75），其中真正「图池捞不到 gold」的 4 题密度中位数仅 **35%**（14/20/50/75）。这印证了兜底判据（可链接子集命中率）作为「检索端结论可信度前提」的设计是对的——链接层不行，图池必然空。

### 抗回退与图排序稳定性

- **抗回退（30 题规模下才被真正检验）**：基线已满的 18 题，merged **18/18 全部保住**，回退 0 题。10 题子集时基线太高、几乎没有可回退的题，这项能力此前未被验证；本轮 18 题样本给出了明确证据。
- **图排序不稳定，不能整片替换基线**：纯图 R@3 = 100% 的 24 题、= 0% 的 6 题；且 qst_0183 / qst_0192 **基线满分但纯图 0 分**。→ A 档落地必须保留「基线优先 + 图做补充位」的增量式架构，禁止用图排序覆盖基线结果。本轮归因口径的选择是对的。
- **新增可达 gold 仅 1 题**（qst_0201）：其余 5 道翻中题的 gold 本就在基线 top10 内，属**重排序增益**（把 top10 里的 gold 顶进 top3），而非召回增益。这正是 A 档设计目标（应用层内存图重排），符合预期；但也说明 A 档对「基线 top10 完全召回不到」的题几乎无能为力。

## v2 通道贡献（三点改造的收益来源）

- 语义通道：✅ 启用（bge-m3 @ http://127.0.0.1:11434），实体向量 1183 条，本轮新嵌入 1498 条
- 语义候选覆盖面：185 个 mention 的候选池中出现纯语义补充候选（阈值 sim ≥ 0.5，补充槽位 4）
- 语义净贡献：30 个 mention 仅靠纯语义候选才链接成功
- 别名提权：74 个 mention 链接命中别名键（alias→canonical 映射共 568 条）
- 确认阈值：主口径 conf ≥ 0.6（判定用），严格口径 conf ≥ 0.85（对照 v1 二元确认，防止把阈值放宽误读为能力变强）

## 跨轮对比（vs `.tmp/kg-spike-v2-seed2/spike-data.json`）

> ⚠️ **本表仅供链接层口径参考，检索层（R@3）各行不可直接比。**
> 两轮题集与基线不同（上一轮 59 mention / 基线 R@3 80.0%，本轮 185 mention / 基线 R@3 60.0%），
> 题集越大越难，基线越低则 headroom 越大。
> 故 `merged R@3` 与 `提升/回退题数` 的 Δ **不是能力变化**，只反映题集难度差异；
> 跨轮判定一律以 **提升 / headroom** 归一口径为准（见上方判定结论表），不读本表的绝对 Δ。

| 指标 | 上一轮 | 本轮 | Δ | 可比性 |
|------|--------|------|-----|--------|
| 基线 R@3（题集难度基准） | 80.0% | 60.0% | -20.0% | 基准值，非结论 |
| linkRate（主口径） | 50.8% | 57.8% | +7.0% | 诊断，不设门 |
| 严格口径 linkRate | 28.8% | 24.3% | -4.5% | 诊断，不设门 |
| 题目级命中率 | 100.0% | 100.0% | +0.0% | 可比（比例型） |
| merged R@3 | 100.0% | 80.0% | -20.0% | ❌ 不可比（题集不同） |
| 提升 / 回退题数 | 2 / 0 | 6 / 0 | +4 / +0 | ❌ 绝对数不可比，须除 headroom |
| 唯一实体键 | 425 | 1183 | +758 | 规模差，非质量差 |
| 判定 | REVIEW | PASS | — | 判据已修正，两轮不可直接对照 |

> 📌 **本小节为事后修正**：原生成的表格缺少「可比性」列与不可比警告，易被误读为 A 档能力退化。
> 已同步修正 [`kg-link-spike.ts`](../../scripts/bench/kg-link-spike.ts) 的 `comparisonLines` 生成逻辑，后续运行自动带上警告。
> 修正只动了报告的**表述**，未动任何测量数值（`spike-data.json` 为唯一数据源，未改）。

## 数据域

- 题目：30 题（gate 选题前 30，与 30 题门闩同口径可配对）
- gold 文档并集：30 篇，成功抽取 30 篇
- 唯一实体键：1183，三元组：555，倒排 token：1071
- Token 用量：调用 71 次 / 输入 113822 / 输出 867010

## 逐题明细

| qid | mention | 链接 | 精确 | 基线R@3 | mergedR@3 | 纯图R@3 | 新增gold |
|-----|---------|------|------|---------|-----------|---------|----------|
| qst_0176 | 4 | 3 | 1 | 100.0% | 100.0% | 100.0% | 0 |
| qst_0177 | 7 | 2 | 1 | 100.0% | 100.0% | 100.0% | 0 |
| qst_0178 | 3 | 3 | 1 | 0.0% | 100.0% | 100.0% | 0 |
| qst_0179 | 8 | 5 | 0 | 100.0% | 100.0% | 100.0% | 0 |
| qst_0180 | 6 | 3 | 1 | 100.0% | 100.0% | 100.0% | 0 |
| qst_0181 | 7 | 2 | 0 | 100.0% | 100.0% | 100.0% | 0 |
| qst_0182 | 6 | 2 | 1 | 100.0% | 100.0% | 100.0% | 0 |
| qst_0183 | 7 | 1 | 1 | 100.0% | 100.0% | 0.0% | 0 |
| qst_0184 | 5 | 4 | 2 | 0.0% | 100.0% | 100.0% | 0 |
| qst_0185 | 6 | 5 | 3 | 100.0% | 100.0% | 100.0% | 0 |
| qst_0186 | 8 | 6 | 1 | 0.0% | 0.0% | 100.0% | 0 |
| qst_0187 | 7 | 1 | 0 | 0.0% | 0.0% | 0.0% | 0 |
| qst_0188 | 6 | 4 | 0 | 100.0% | 100.0% | 100.0% | 0 |
| qst_0189 | 7 | 3 | 0 | 100.0% | 100.0% | 100.0% | 0 |
| qst_0190 | 3 | 2 | 0 | 100.0% | 100.0% | 100.0% | 0 |
| qst_0191 | 8 | 4 | 1 | 0.0% | 0.0% | 100.0% | 0 |
| qst_0192 | 5 | 3 | 0 | 100.0% | 100.0% | 0.0% | 0 |
| qst_0193 | 5 | 3 | 1 | 0.0% | 100.0% | 100.0% | 0 |
| qst_0194 | 8 | 5 | 3 | 100.0% | 100.0% | 100.0% | 0 |
| qst_0195 | 7 | 6 | 1 | 100.0% | 100.0% | 100.0% | 0 |
| qst_0196 | 4 | 4 | 3 | 100.0% | 100.0% | 100.0% | 0 |
| qst_0197 | 6 | 3 | 0 | 0.0% | 0.0% | 0.0% | 0 |
| qst_0198 | 8 | 7 | 2 | 100.0% | 100.0% | 100.0% | 0 |
| qst_0199 | 3 | 1 | 0 | 100.0% | 100.0% | 100.0% | 0 |
| qst_0200 | 4 | 3 | 0 | 0.0% | 0.0% | 0.0% | 0 |
| qst_0201 | 8 | 4 | 0 | 0.0% | 100.0% | 100.0% | 1 |
| qst_0202 | 8 | 6 | 4 | 100.0% | 100.0% | 100.0% | 0 |
| qst_0203 | 8 | 5 | 2 | 0.0% | 100.0% | 100.0% | 0 |
| qst_0204 | 5 | 1 | 0 | 0.0% | 0.0% | 0.0% | 0 |
| qst_0205 | 8 | 6 | 0 | 0.0% | 100.0% | 100.0% | 0 |

## 未链接 mention 归因样例

> textPresentInGold=true 表示该表述（或变体）在 gold 正文中原样出现，却没被抽成实体或没被链接上
> —— 属于「抽取/链接能力不足」；false 属于「问题改写与文档表述的语义鸿沟」。

- [qst_0176] "India South"　gold中出现=false　候选=ap-south-1 / in-console / Latency-tier Presets in Console
- [qst_0177] "retail partner purchase"　gold中出现=false　候选=AWS Marketplace / Marketplace / 15% partner rev-share
- [qst_0177] "retail partner"　gold中出现=false　候选=alex.ortiz@cytohealth.com / alice@aurora.com / atlasbridge.com
- [qst_0177] "referral payout schedule after launch"　gold中出现=false　候选=tools_schema_refs / next maintenance window / urgency-based scheduler
- [qst_0177] "final concession terms"　gold中出现=false　候选=coalesces an SSI keepalive packet with the final JSON boundary / request=req_6f3a / reservation approval queue
- [qst_0177] "launch"　gold中出现=true　候选=Product / Ivy Chen (product lead) / Product (owner)
- [qst_0179] "vectorization service"　gold中出现=false　候选=2-week Hosted API POC / Admin API / admin-api
- [qst_0179] "load spike"　gold中出现=false　候选=automated load-shedding triggers / bifurcate traffic / Load-shedding rules
- [qst_0179] "ingestion timeouts"　gold中出现=false　候选=fastpath (no batching, low-latency multiplexer) / latency_95p<250ms / Latency-tier Presets
- [qst_0180] "new mechanism"　gold中出现=false　候选=2026.02 release branch / authoritative release signature / bifurcate traffic
- [qst_0180] "rollout system"　gold中出现=true　候选=canary rollout / Rollout Recommendation API / rollout.traffic_escrow
- [qst_0180] "smoke checks"　gold中出现=false　候选=`tests/integration/batching/large_sequence_stress.py` / `tests/unit/test_cache_normalization.py` / Bayesian sequential test
- [qst_0181] "short lived credentials"　gold中出现=false　候选=service account 'onboard-runner@aurora' / resume tokens / read-only tokens
- [qst_0181] "too many requests errors"　gold中出现=false　候选=rehearsal_sandbox_errors_total / Sandbox Requests / offer call
- [qst_0181] "refresh bursts"　gold中出现=false　候选=10% global burst pool / 40/40/20 split + small global burst / cookie refresh POSTs
- [qst_0181] "partial worker restart"　gold中出现=false　候选=worker restart time / ephemeral worker pools / resume token
- [qst_0181] "large overnight upload run"　gold中出现=false　候选=embeddings pipeline / Rehydration pipeline / release pipeline
- [qst_0182] "default time window"　gold中出现=false　候选=resume token / opaque resume token / valid resume token
- [qst_0182] "failover between two active locations"　gold中出现=false　候选=existing automation / emergency fallback routing / per-connection checkpointing
- [qst_0182] "two active locations"　gold中出现=false　候选=double-terminal marker / model-cache / Applied ML

## 链接成功样例（前 10 条）

- [qst_0176] "new top end 80GB accelerator" → h100 / H100x1 (80GB)
- [qst_0176] "dedicated clusters" → Dedicated
- [qst_0176] "EU Central" → eu-central-1
- [qst_0177] "major cloud providers marketplace" → AWS Marketplace / Marketplace
- [qst_0177] "first year price reduction" → 30% first-year discount
- [qst_0178] "default pass rate" → kernel_stability_threshold
- [qst_0178] "safest numeric mode" → fp32 / safe fp32
- [qst_0178] "low bit math" → low-precision kernels
- [qst_0179] "Western Europe" → eu-west / eu-west-1 / eu-west1
- [qst_0179] "Southeast Asia" → ap-southeast / ap-southeast-1

## 局限（读结论前必看）

1. **本轮为 30 题全量门闩**：headroom = 12 题（基线 R@3 已满的 18 题在数学上不可能被提升）。主判据要求 提升 ≥ 6 题（12 × 0.5），这是**在 headroom 内翻中一半**的强度，不是「30 题里提升一半」——后者在本归因口径下不可能达成，读数时切勿混淆。
2. **文档域仅 30 篇**（本次题目 gold 并集），实体键 1183 / 三元组 555，远小于全库（约 325 篇）规模。候选实体池越小，链接越容易命中，故链接层指标 **系统性高估**全库表现；全库还需面对同名实体消歧问题，本次未覆盖。
3. **归因口径保守**：merged = 基线 top2 + 图补充 1 位，最多顶掉 1 个基线结果、最多翻 1 题，不夸大收益；但也因此 merged R@3 无法反映图排序自身质量，须同时看"纯图排序 R@3"（80.0%）。
4. **模型思考块开销**：deepseek:deepseek-v4-flash 为 Thinking 模式，输出 token 显著膨胀。本次 71 次调用消耗输入 113822 / 输出 867010 token，推广到 30 题门闩与全库离线抽取时，成本与耗时须按此折算。
5. **本轮为 30 题门闩的正式定档轮（单轮固定 seed=20260923）**：按用户批准的修正判据，门闩只跑**一轮**、seed 固定，不再多轮换 seed 择优——多轮择优等价于把判定线偷偷放宽。代价是本轮无法给出采样噪声的置信区间；10 题两轮实测的采样一致率为 88.1%，翻转项置信度全部落在 0.4~0.8 的阈值边界带，可据此估计本轮链接层抖动幅度，但检索端结论不再有重复验证。
6. **语义通道参数未做敏感性分析**：语义补充通道依赖本地 Ollama 嵌入模型（cos 阈值 0.5、补充槽位 4），两者均为启发式取值——阈值调高会减少进池候选，槽位调大会放大语义通道影响。词汇通道严格保持 v1 口径（top 8、score ≥ 0.3）；嵌入服务任何失败都自动降级为纯词汇通道，不中断主流程。
7. **主判据分母（headroom）本身很小**：headroom = 12 题，意味着 6 题提升就对应 50.0%——分母越小，单题抖动对判据的影响越大（1 题 ≈ 8.3%）。因此**必须与「回退题数」「新增可达 gold」一起读**：若提升数刚好压线且回退 = 提升，应视为 REVIEW 而非 PASS。