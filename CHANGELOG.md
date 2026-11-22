# Changelog

所有重要的项目更改将记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

### Added

### Changed

### Fixed

### Removed

---

## [0.12.7] — 2026-11-22

### Added

- **内置 cron 调度器**（`ctx.oniCron`），彻底移除对 `koishi-plugin-cron` 的依赖：
  - `src/utils/cron.ts`：表达式解析 + 下次触发时间计算（纯函数，可单测）。
    支持 5 段（分 时 日 月 周）与 **6 段（秒 分 时 日 月 周）**、`*`/`N`/`a-b`/`*/n`/`a-b/n`、
    逗号组合、月份与星期英文缩写、`@daily` 等宏；日与周同时受限时按 Vixie cron 的 OR 语义
  - `src/services/cronScheduler.ts`：用 `ctx.setTimeout` 链式排期（插件卸载自动清理），
    同一任务串行执行（上次未结束则跳过）、异常只记日志、支持 `cancel()` 与 `list()`
  - `src/plugins/cronService.ts`：把调度器挂到 `ctx.oniCron`，排在 `SUB_PLUGINS` 最前

### Changed

- `syncCommands` / `updateCommands` / `todoList` 的定时任务改用 `ctx.oniCron(表达式, 任务, 名称)`，
  每个任务都带可读名称，注册失败时日志能直接指出是哪一个
- `list()` 可用于排查：`ctx.oniCron.list()` 返回 `{ id, name, expression, next }`

### Removed

- 移除依赖 `koishi-plugin-cron` 与 `import {} from "koishi-plugin-cron"`，
  三个子插件的 `inject` 中不再声明 `cron`
- 旧 `koishi.yml` 里的 `cron:xxxxxxxx: {}` 可以删掉（留着也无害，只是没人用）

### Fixed

- 顺带修掉 `client/tsconfig.json` 中的非法 JSON（缺逗号 + 空单引号导致 `vite` 构建失败）

> **兼容性**：原 `syncCommands` 里的 `0 0 2 * * 0` 是 6 段写法（周日 02:00），
> 新解析器默认把 6 段的第一段当秒，行为不变。

---

## [0.12.6] — 2026-11-22

### Fixed

- **群内承接会把上一轮的资料套到新问题上**：`searchPage` 的追问兜底原来是无条件的——
  关键词解析不出页面就沿用上一轮抓到的页面，于是群里聊过「氧石精炼炉」之后，
  任何人问一个 BWiki 上没有的新词条（「水泵有什么用」）都会拿到氧石精炼炉的正文，
  模型只能答非所问甚至编造数值。现在只有两种情况才沿用：
  - 关键词里明确点名了上一轮页面（「氧石精炼炉的材料」）；
  - 关键词剔掉指代/属性/疑问词后不剩任何实体（「耗电多少」「那它能干什么」）。
  其余情况一律回「资料中未提及」，不再拿上一轮的页面凑答案
- **多人群聊会串台**：只要群里有人问过，下一个人的提问就会带着**别人的问答**进模型——
  A 问电解器、B 问水泵、C 问电解器耗电时，C 的第一轮请求里塞着 B 的「水泵」问答，
  回答容易混进别人的词条。现在**历史上下文只在「纯追问」时才加载**：
  自带实体的问题（「水泵有什么用」「电解器耗多少电」）一律零历史、独立检索；
  自己的历史也按同一规则处理（换话题时不回放自己的上一问）
- **群话题回放别人的答案正文**：改了提问者时，上一轮的答案整段进入 messages，
  模型会把别人的资料当成当前问题的事实。现在群内话题**只回放「问的是什么」**
  （包成一条注明「不是当前问题」的 system 提示），答案正文不再回放；
  自己的历史答案则压缩成 200 字摘要
- **`💭 承接群内上一问` 标注误报**：只要存在群话题就会标注，哪怕本轮是独立检索到的新页面。
  现在只有真正复用了上一轮页面时才出现
- 历史里答「未提及」的轮次不再回放给模型：这类轮次没有可用信息，
  回放只会让模型倾向于继续答未提及

### Changed

- 两套提示词补上「换话题」约束：问题里出现新词条时必须按新词条检索，禁止把历史里的词条当作检索对象；
  资料讲的是 A、问的是 B 时直接回答未提及
- 纯属性/指代词（「耗电多少」）不再被原样当作页面标题去抓，省掉一次必然 404 的 `action=parse`
- 追问兜底改为取**最近一个真正查到过页面的**轮次，不再假设最后一轮一定有页面
- 群话题只在**真的查到页面**时才更新：没查到页面的纯追问不会把原本有效的群话题冲掉

### Added

- 导出 `residualSubject()` / `isPureFollowUp()` 两个纯函数（`plugins/aiQueryCommands`），
  配套 16 个测试用例：覆盖「实体名不被词表切坏」（干板墙 / 高压制氧 / 小行星 / 大嘴鱼…）、
  追问判定、换话题不被带偏、未提及轮次不回放、多人群聊隔离（4 人交替提问 + 群话题只回放问题）

---

## [0.12.5] — 2026-11-20

> 收尾清理：把 0.12.0 起已废弃但为兼容旧配置保留的键位彻底删掉，并给关键词解析加上请求数上限。

### Removed

- 删除整组**向量检索配置**（`VectorConfig`）：`vectorEnabled`、`vectorIndexPath`、`embeddingModel`、
  `embeddingDtype`、`embeddingCacheDir`、`embeddingRemoteHost`、`chunkSize`、`chunkOverlap`、
  `maxChunksPerPage`、`retrieveTopK`、`retrieveMinScore`、`queryInstruction`、`embedBatchSize`
- 删除整组**渲染文本落库配置**（`WikiTextConfig`）：`textSyncOnChange`、`textApiUrl`、`textTableMode`、
  `textMaxLength`、`textSyncInterval`
  - 配置项从 42 个减少到 24 个，控制台不再显示一堆「⚠️ 已废弃」的空字段；
  - 旧 `koishi.yml` 里残留这些键**不会报错**（schema 中已无这些键，程序也不再读取任何一项），可以顺手删掉；
  - 新增 `tests/config.spec.ts` 用例锁定这批键不再出现
- 删除 `QueryCommands` 里从不读取的 `ctx` 字段、`findPreciseMatch()` 的两个未使用参数，
  以及 `routeRedirect` 里未使用的 `next` 参数

### Changed

- 关键词解析（`resolveTitles`）加上请求数上限，避免长关键词把一次问答拖成七八个请求：
  候选词最多 3 个（整句 + 按空格/标点拆出的片段）、BWiki 全文检索最多 2 次、正文抓取最多 4 次
- 不再对每个片段都发起 `list=search`：只有前两个候选会走全文检索，其余靠本地精确/拼音匹配

---

## [0.12.1] — 2026-11-20

### Added

- 新配置 `aiCodeBlockMinChars`（默认 `180`）：QQ 下回答超过该字数时整段塞进代码块。
  QQ 的 markdown 消息会把代码块渲染成一张可复制的卡片，手机端不再被长回答刷屏；
  设为 `0` 可恢复「所有回答都用普通 markdown」

### Changed

- `.ai` 的 QQ 回复按长度二选一：短回答保持 `**加粗**` + `•` 列表的普通 markdown，
  长回答进代码块；`💭 承接群内上一问` 与 `📚 数据来源` 始终留在代码块外
- 进代码块前会把正文里的 markdown 标记转成纯文本（`**粗体**` → `粗体`、`### 标题` → `标题`、
  `- 列表` → `• 列表`、`[文字](链接)` → `文字`），因为代码块里这些标记不会被渲染
- 代码块围栏长度按正文中最长的连续反引号动态决定（至少三个），
  避免模型输出里自带三个反引号时把围栏提前闭合

---

## [0.12.0] — 2026-11-20

> **破坏性变更**：`.ai` 不再使用本地向量检索，改为 DeepSeek Function Calling + mwn 实时抓取正文。
> 升级后需执行 `npm uninstall vectra @huggingface/transformers`，并删除 `data/oni-vector`、`data/oni-models`。

### Added

- `WikiBotService.fetchPagePlainText(title, { limit?, bypassCache? })`：复用已登录的 mwn 实例，
  经 `parseTitle`（即 `action=parse&prop=text`）取**渲染后**的 HTML，再用 cheerio 抽成纯文本；
  页面不存在（`missingtitle` 等）、未登录、网络失败统一返回 `null`，调用方无需 try/catch
- 正文抽取默认截断 **3000 字**（`limit` 可覆盖），并按「小写标题」做 **10 分钟 / 最多 50 页** 的进程内缓存，
  避免群聊里反复请求同一页触发 bwiki 的 WAF 限流
- `WikiBotService.searchPageTitles(keyword, limit)`：`list=search` 全文检索，用于关键词→标题的第三级解析
- `AiService.complete(messages, { tools, toolChoice })`：完整的 Function Calling 支持，
  返回解析后的 `toolCalls` 与可原样回传的 assistant 消息
- `ai` 命令改为 **Agent 工具调用**：`search_oni_bwiki(keyword)` → 本地匹配标题 → mwn 取正文 →
  以 `role:'tool'` 回填 → 第二轮生成回答；日志记录 `[ai] Agent 决定检索: <title>`
- 新增测试 `tests/aiAgent.spec.ts`（tool_call 配对、强制检索、追问兜底、上限跳过）与重写的 `tests/aiService.spec.ts`

### Changed

- 关键词→标题改为**三级解析**：`wikipages` 精确标题 → 拼音/首字母模糊匹配（分数门槛 8，纯首字母命中不可信）
  → BWiki 全文检索 → 关键词原样当标题
- 模型未发起工具调用时，用 `tool_choice: 'required'` **强制检索一次**，防止模型凭记忆作答
  （该请求失败时会退回模型第 1 轮的回答，不会让整次问答报错）
- 第 2 轮带 `tools` 但 `tool_choice: 'none'`：消息结构对所有 OpenAI 兼容层都合法，
  同时明确禁止再次调工具；单次最多执行 2 个 `tool_call`，
  超出的也必须补一条 `role:'tool'` 消息（否则下一次请求不合法）
- 追问记忆 `MemoryTurn.chunks` 改为 `MemoryTurn.page`：记这一轮查了哪个页面，
  关键词解析失败时可直接复用该页；旧 `oniaimemory` 行里的 `chunks` 字段运行时忽略
- `ai.status` 改为展示「检索方式 / BWiki 客户端状态 / 本地页面缓存数」，不再报告索引体积
- `.ai` 的日志改用 `ctx.logger("oni-ai")`

### Fixed

- 信息框数值仍然保留：清洗沿用 `extractPlainText` 的 `flatten` 策略（**不删 `<table>`**）。
  实测 `电解器` 2637 字含 `电力：消耗 120 瓦` / `过热：75°C`，`氧石精炼炉` 939 字含
  `电力：消耗 1200 瓦` / `建造时间：480 秒`；若按字面删掉全部表格，两页会掉到 2620 / 586 字且**不含任何数值**

### Removed

- 删除 `src/services/vectorService.ts`、`src/sync/textSync.ts` 及 `tests/textSync.spec.ts`
- 删除命令 `ai.sync`、`ai.reindex`
- 删除 `PageSyncer.onSynced` 钩子与 `SyncCommands` 里的渲染文本同步接线（唯一消费者已移除）
- 删除 `utils/renderText.ts` 的 `chunkText` / `splitLongLine`（只被向量库使用）
- 删除 `wikitexts` 表声明与 `tryGetBWikiBot` 辅助函数（旧表数据留在库里，不再读写）
- 依赖移除：`vectra`、`@huggingface/transformers`

### Deprecated

- 配置项 `vectorEnabled` / `vectorIndexPath` / `embedding*` / `chunkSize` / `chunkOverlap` /
  `maxChunksPerPage` / `retrieveTopK` / `retrieveMinScore` / `queryInstruction` / `embedBatchSize`，
  以及 `textSyncOnChange` / `textApiUrl` / `textTableMode` / `textMaxLength` / `textSyncInterval`
  已不再读取，**保留键位**只是为了让旧 `koishi.yml` 不报错

---

## [0.11.0] — 2026-11-20

### Added

- 新增 `.ai` 问答：BWiki `action=parse` 渲染文本 → `wikitexts` 表 → 本地向量检索（vectra + transformers.js `bge-small-zh`）→ DeepSeek 总结，回复末尾标注「数据来源：缺氧 BWIKI」
- `src/services/vectorService.ts` — `ctx.vector` 服务：文本切块、本地 Embedding、vectra 索引读写
- `src/services/aiService.ts` — DeepSeek 客户端与防幻觉提示词组装
- `src/services/aiMemory.ts` — 短期记忆（用户 / 群话题）与 `pickContext` 选择逻辑（纯函数）
- `src/sync/textSync.ts` — `RenderedTextSyncer`：抓取渲染文本并落库（sha1 去重）
- `src/utils/renderText.ts` — HTML → 纯文本、文本切块的纯函数
- `src/plugins/aiQueryCommands.ts` — `ai` / `ai.status` / `ai.sync` / `ai.reindex`
- `PageSyncer` 新增可选 `onSynced` 钩子：页面同步成功后自动抽取渲染文本
- 新增 `wikitexts` 表（主键为页面标题）与「渲染文本 / 向量 / AI」三组配置
- `.ai` 短期记忆：按「平台 + 频道 + 用户」保留最近 2 轮（`aiMemoryTurns` / `aiMemoryTtl`），
  追问时把上一轮问题并入检索串，检索为空时复用上一轮资料
- `.ai` 群内话题承接（`aiChannelMemory`）：自己没有提问记录时使用群里上一轮问答的语境，
  回复中标注「💭 承接群内上一问」，回答「未提及」的轮次不会成为群话题
- 追问记忆**落库**（`oniaimemory` 表）：Koishi 重启 / 热重载后仍能承接上一问，过期行自动清理
- `ai.status` 增加「索引体积」「群内追问」与低配内存提示

### Changed

- `SyncCommands` 的 `PageSyncer` 统一由 `createPageSyncer()` 构造，集中装配数据库、通知与 `onSynced`
- `ai.sync` 不再依赖本地页面缓存：`wikipages` 为空时自动用 bwiki `list=allpages` 枚举
- 抓取渲染文本优先走已登录的 bwiki 客户端（惰性获取，登录完成后自动接管），`ctx.http` 兜底时自动补 `Referer`
- `maxChunksPerPage` 默认值 24 → 16（索引常驻内存约每块 6~7 KB，2G 机器建议 12）
- `retrieveTopK` 默认值 3 → 5：信息框里的数值块通常排在第 4 位，取 3 块会正好漏掉
- 取消「同一页面最多取 2 块」的限制：数值题常常需要同页多个片段，去重反而漏召回
- 切块改为按信息框分组标题（`[效果]` / `[建造]`…）优先断块，让「电力：消耗 120 瓦」独立成块
- 追问时会**钉住话题页的第 0 块**（信息框/简介），不再单纯依赖相似度排名召回关键数值
- **话题页补全**（回答不再只覆盖页面开头）：
  - 话题页的判定顺序改为「问题里点名的页面 → 上一轮记忆 → 命中里过半来自同一页」，
    「氧石精炼炉怎么用」这种问法不再被拆到氧石、铁、绿叶小行星几页上；
  - 点名页面或宽泛问题时把该页**整页**交给模型（预算 5000 字 / 12 块）：「电解器能干哈」
    的上下文从 5 块 1.3k 字增加到 12 块 3.1k 字，自动化、技巧、版本历史都进得去；
  - 追问仍只补该页最相关的 3 块（上限 `retrieveTopK + 2`），保持聚焦
- 新增依赖：`vectra`、`cheerio`、`@huggingface/transformers`；`koishi-plugin-cron` 改为软依赖
  （`vectra@0.15` 声明 `engines: node >= 22`，运行环境建议 Node 22+）

### Fixed

- **信息框被当噪音删掉，导致耗电 / 产热 / 尺寸 / 材料等关键数值完全没有进检索**：
  `extractPlainText` 现在把 `table.infobox` 抽成「标签：值」文本行（含 `infobox-group` 分组卡片），
  只丢弃导航框、目录、折叠按钮与「不同材料」变体表
- 文本切块的重叠区改为从行首开始，避免把半个词带进下一块
- **`sync` / `update` / `todolist` 命令在未启用 `koishi-plugin-cron` 的实例里整组消失**：
  `cron` 改为可选依赖（`inject: { cron: { required: false } }`），缺省时只跳过定时任务并打警告
- **`ai.sync` 大量失败（HTTP 567）**：bwiki 的 WAF 要求 `Referer`，补齐后恢复正常；
  `missingtitle`（页面不存在）单独归类为 `missing`，不再计为失败
- `allpages` 兜底忽略 `maxPages` 上限，可能一次抓 500+ 页
- AI 回答「未提及」时不再列出无关的检索来源，避免误导
- **信息框数值明明存在却回答「未提及」**：信息框块被混在 287 字的大块里、且排在检索第 4 位，
  叠加「每页最多 2 块 + 只取 3 块」后被裁掉；现已按分组断块并放宽召回
- **重启后追问失去主语**（插件热重载 / 进程重启后「耗电多少」变回孤立问题）：记忆改为落库 + 话题块钉入上下文
- **旧版本同步过的页面正文偏短**（如 `氧石精炼炉` 只有 586 字、没有「效果/建造」数值）：
  抽取器升级后 `hash` 会变化，执行一次 `ai.sync` 即可重新抽取并自动重建该页的向量块
  （新版抽取结果 877 字，含 `电力：消耗 1200 瓦`、`建造时间：480 秒`）

### Removed

---

## [0.10.1] — 2026-10-16

### Fixed

- `WikiBotService` 的客户端代理在转发方法时丢失 `this` 绑定，导致 `continuedQueryGen` 抛 `Cannot read properties of undefined (reading 'request')`，所有批量路径（`sync.allpages` / `sync.allmodules` / `sync.allimgs` / `增量更新` 及对应定时任务）在第一次迭代即失败。现统一用 `apply(bot, args)` 转发；该逻辑抽到 `src/services/reloginAwareProxy.ts`，并补上回归测试（含「裸调用必然丢 this」的对照实验，防止测试退化为空测）

---

## [0.10.0] — 2026-10-16

大规模可维护性重构：消除模块级可变单例、按职责拆分上帝类、统一重试与配置声明、补齐单元测试，并修正查询打分的空串缺陷。

### Added

- 建立单元测试体系（`tests/`，`yarn test` = tsc 进程内编译 + mocha 单进程加载，不依赖 esbuild），共 74 个用例覆盖纯函数、匹配算法、依赖注入与配置 schema
- `src/utils/matcher.ts` — 从 `queryCommands.ts` 抽出的纯匹配/打分逻辑
- `src/utils/async.ts` — 统一的 `sleep` 与 `withRetry`
- `src/services/messageRenderer.ts` — QQ markdown/按钮 与 纯文本的平台差异渲染
- `src/services/syncNotifier.ts` — 从 `syncCommands.ts` 抽出的同步结果群通知
- `src/config.ts` — 配置的唯一声明处（账号 / 站点 / 通知 / 定时 四个分组）
- `WikiBotService.ensureReady()` — 机器人就绪检查回到服务层
- `src/sync/` 新增 `ModuleSyncer` / `ImageSyncer` / `PageSyncer` 三个类

### Changed

- `src/index.ts` — 子插件改为 `SUB_PLUGINS` 注册表，新增子插件只需加一行；配置类型通过 `Pick` / `extends` 从共享分组派生
- `src/sync/*` — 模块级 `CONFIG` 单例改为构造注入的 options；三个同步器的构造签名统一为 `(source, target, deps?)`
- `WikiBotService` — `ggbot` / `bwikibot` 收为 private（编译期禁止外部穿透），`isReady` 由手工同步的字段改为派生 getter
- 重试逻辑由三套实现统一为 `withRetry`，失败时抛出原始错误本身
- `src/services/consoleLogProvider.ts` — 日志缓冲由模块级变量改为实例状态
- TypeScript 开启 `strictNullChecks`，全仓库 `--strict` 亦通过
- 全仓库消除 `any`（21 处 → 1 处），仅保留 MediaWiki 响应边界的必要断言

### Fixed

- `src/utils/matcher.ts` — 空查询串不再产生匹配信号。此前纯拉丁查询（`Refinery` 的拼音首字母为空串）会让**每个页面白得 6 分**、全符号查询（全拼与首字母均为空）会让**每页白得 23 分**，导致「没有匹配」反而返回若干随机页面
- `src/utils/tools.ts` — `formatWikiTime()` 混用本地时区与 UTC 取值，仅在 UTC+8 机器上碰巧正确；改为时区无关实现，并由 `Date` 正确处理 +8 造成的跨日/跨月/跨年进位
- `src/plugins/queryCommands.ts` — 模糊匹配算法新增公共前缀匹配评分，解决相近词条无法返回待选列表的问题（0.9.3 开发中的修复，随本次发布）

### Removed

- 删除 8 个子插件文件里无人调用的 `export function apply`（组合根是 `src/index.ts`）
- 删除 `imgSync.ts` 中被导出但全仓库无引用的 `CONFIG`
- 删除 `imgSync.ts` / `pageSync.ts` 中从未被读取的 `config: Config` 死参数链
- 删除各子插件重复的配置声明（`domain` 曾声明 3 次，`main_site` / `bwiki_site` / `logsUrl` 各 2 次，4 个账号字段各 2 次，共 9 处重复），`Schema.object` 现在只出现在 `config.ts`

---

## [0.9.2] — 2026-07-23

### Added

- `client/onilogs/` 新增日志模块独立文件夹，包含 `index.vue` 和 `logs.vue`
- `src/utils/tools.ts` 新增通用工具函数：`normalizeChannelId()`、`truncateComment()`、`normalizeImageTitle()`、`stripImagePrefix()`
- `src/plugins/syncCommands.ts` 新增 `sync.contributor <title>` 和 `sync.allcontributors` 命令
- `src/plugins/syncCommands.ts` 新增每周日凌晨2点的贡献者同步定时任务

### Changed

- `src/plugins/syncCommands.ts` — 将贡献者同步功能从独立插件合并到此文件中
- `src/utils/tools.ts` — 集中管理通用工具函数，从 `syncCommands.ts` 和 `imgSync.ts` 迁移
- `client/index.ts` — 日志页面路径改为 `/`，替换 Koishi 默认欢迎页
- `client/index.ts` — 页面注册改为使用 `id: "home"` 覆盖默认欢迎页，并添加 `ready` 事件处理确保首次访问正确显示

### Fixed

- `src/sync/pageSync.ts` — 增量更新时贡献者和日期信息在内容未改变时不会更新的问题，修复为只要有变更记录就更新数据库
- `src/plugins/syncContributor.ts` — `getContributorsAndTimestamp()` 函数中使用 `this.logger` 导致的 bug

### Removed

- 删除 `src/plugins/syncContributor.ts` 文件
- 删除 `client/page.vue` 文件

---

## [0.9.1] — 2026-06-24

### Added

- `src/plugins/routeRedirect.ts` 新增 `/ggwiki` 路由重定向，支持路径和查询参数透传

### Fixed

- `src/plugins/routeRedirect.ts` — 正则表达式不匹配空路径、单独斜杠和中文路径的问题，修改为使用 Unicode 属性转义 `\p{L}\p{N}` 支持多语言字符
- `src/plugins/routeRedirect.ts` — 路径遍历防护不完善，攻击者可通过 URL 编码（如 `%2e%2e`）绕过检测，修复为使用 `decodeURIComponent` 解码后再检查
- `src/plugins/syncContributor.ts` — `apply` 函数缺少配置参数传递，构造函数未接收配置参数
- `src/plugins/syncContributor.ts` — 使用 `console.error` 而非统一的 `this.logger.error`
- `src/utils/tools.ts` — `formatWikiTime()` 未处理时区，UTC 时间直接转换为本地时间，修复为转换为北京时间（UTC+8）
- `src/sync/pageSync.ts` — 图片图标显示为乱码 `�️`，修正为 `🖼️`

---

## [0.8.9] — 2026-06-22

### Added

- `src/sync/imgSync.ts` 新增 `normalizeImageTitle()` 和 `stripImagePrefix()` 两个标题格式规范化工具，确保查询类 API 调用时标题以 `File:`/`Image:`/`文件:` 前缀开头，`upload` API 则使用纯文件名
- `src/plugins/syncCommands.ts` 新增增量更新同步通知：
  - 新增 `notifyGroupIds` 配置项（群频道 ID 列表）
  - 新增 `notifyBotPlatform` 配置项（机器人平台标识，默认 `qq`）
  - 新增 `formatWikiTime()` 将 MediaWiki ISO 时间戳转为 `YYYY-MM-DD HH:mm`
  - 新增 `truncateComment()` 将摘要截断至 10 字（超出用 `...`），防止刷屏
  - 新增 `normalizeChannelId()` 兼容 `group:`/`channel:`/`qq:` 前缀
- `src/sync/pageSync.ts` 新增 `SyncNotifyItem` 接口，包含 `title`、`type`、`user`、`timestamp`、`comment` 字段

### Changed

- `src/sync/imgSync.ts` `syncSingleImage` / `getImageInfo` / `deleteOldVersions`：查询图片信息时统一调用 `normalizeImageTitle()` 补全 `File:` 前缀，避免 MediaWiki 在主命名空间而非 File 命名空间查找图片
- `src/sync/pageSync.ts` `incrementalUpdate`：
  - 同步成功回调从逐个触发改为整轮处理完毕后一次性触发 `onSynced(items: SyncNotifyItem[])`
  - 新增 `processedTitles` 去重逻辑，跳过重复标题
  - 图片处理路径直接使用 `page.title`（含 `File:` 前缀）传入 `syncSingleImage`
- `src/plugins/syncCommands.ts`：
  - 同步通知合并为一条消息输出，格式为 `Wiki 同步更新（N 条）` + 逐行 `📖 1. 标题｜编辑者｜时间｜摘要`
  - 消息不含 URL 链接，避免消息过长

### Fixed

- `src/sync/imgSync.ts` — 增量更新时 `recentchanges` 返回的图片标题（如 `水生小动物使用示例.png`）因缺少 `File:` 前缀导致查不到源站图片、报"源站未找到图片"的问题
- `src/plugins/syncCommands.ts` — QQ 群推送消息格式混乱、刷屏的问题
- `src/plugins/syncCommands.ts` — `notifyFn` 异步函数最外层未包裹 try-catch，消息发送阶段的异常会冒泡至 `incrementalUpdate` 主流程导致整体同步被误判失败的问题

### Removed

- 移除调试用测试命令 `sync.testNotify`

---

## [0.8.8] — 2026-06-19

### Added

- 发布基础 Wiki 站点同步功能（页面/图片）
- Wiki 机器人登录与重登逻辑
- 路由重定向（Wiki 站间跳转）
- 页面拼音查询与模糊搜索命令
- 定时任务（基于 `koishi-plugin-cron`）

[Unreleased]: https://github.com/Charles-lf/oni-sync-bot/compare/v0.12.7...HEAD
[0.12.7]: https://github.com/Charles-lf/oni-sync-bot/releases/tag/v0.12.7
[0.12.6]: https://github.com/Charles-lf/oni-sync-bot/releases/tag/v0.12.6
[0.12.5]: https://github.com/Charles-lf/oni-sync-bot/releases/tag/v0.12.5
[0.12.1]: https://github.com/Charles-lf/oni-sync-bot/releases/tag/v0.12.1
[0.12.0]: https://github.com/Charles-lf/oni-sync-bot/releases/tag/v0.12.0
[0.11.0]: https://github.com/Charles-lf/oni-sync-bot/releases/tag/v0.11.0
[0.10.1]: https://github.com/Charles-lf/oni-sync-bot/releases/tag/v0.10.1
[0.10.0]: https://github.com/Charles-lf/oni-sync-bot/releases/tag/v0.10.0
[0.9.2]: https://github.com/Charles-lf/oni-sync-bot/releases/tag/v0.9.2
[0.9.1]: https://github.com/Charles-lf/oni-sync-bot/releases/tag/v0.9.1
[0.8.9]: https://github.com/Charles-lf/oni-sync-bot/releases/tag/v0.8.9
[0.8.8]: https://github.com/Charles-lf/oni-sync-bot/releases/tag/v0.8.8
