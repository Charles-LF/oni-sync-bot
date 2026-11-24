# koishi-plugin-oni-sync-bot

[![npm](https://img.shields.io/npm/v/koishi-plugin-oni-sync-bot?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-oni-sync-bot)
[![Koishi](https://img.shields.io/badge/koishi-plugin-42b983?style=flat-square)](https://koishi.chat)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**缺氧 Wiki 镜像站同步机器人插件** — 把 [oxygennotincluded.wiki.gg](https://oxygennotincluded.wiki.gg)（下称 **GG 原站**）的内容**单向镜像**到 B站 Wiki（下称 **bwiki**），并提供拼音页面查询、AI 问答、短链接跳转与通配转发。

> 同步方向是 **GG 原站 → bwiki 单向**，不会把 bwiki 的改动回写原站。

## ✨ 核心功能

### 📄 Wiki 同步

- **双站点登录** — 同时登录 GG 原站与 bwiki，登录失败自动重试（3 次，间隔 5 秒）
- **透明重登录** — 请求过程中一旦发现登录态失效（`assert=user`），自动重新登录并**重放该请求**，调用方无感知
- **页面同步** — 单个页面 / 全量页面（全量仅保留为手动命令，不再定时跑）
- **模块同步** — `Module:` 命名空间页面（含 `Dev:` → `Module:Dev/` 路径映射）
- **图片同步** — 下载原站图片并上传到 bwiki，支持 SHA1 比对跳过与旧版本清理
- **贡献者同步** — 单页 / 全量同步贡献者与最后修改时间
- **增量同步（默认调度）** — 基于**持久化水位**的变更检测：只处理上次成功之后新产生的编辑，
  页面走 `recentchanges`、图片走 `allimages + imageinfo` 指纹比对，不再每小时盲目回溯固定窗口；
  水位会定期做体检，发现「水位越过本地记录」的空隙会自动回退补齐，杜绝永久漏更

### ⚙️ 同步运维面板（控制台首页 `/`）

- **四个任务卡片** — 增量同步 / 全量页面 / 全量图片 / 全量模块，各自独立的状态与进度
- **增量同步自动运行** — 由配置里的 cron 驱动，卡片上只读展示优先级与进度，不提供任何控制按钮
- **其余三个任务可控** — 开始 / 暂停 / 继续 / 停止；取消是**协作式**的，只在两个条目之间检查，
  绝不会打断进行中的 mwn 请求，也不会把任务卡死
- **单任务并发 + 优先级让路** — 同一时刻只跑一个；增量优先，启动别的任务会让正在跑的全量任务自动暂停
- **实时进度** — 阶段、进度条、同步 / 跳过 / 失败计数、当前处理条目
- **最近更改只读** — 落库的 `recentchanges` 列表（默认保留 5000 条），可检索、分页、点开看 unified diff；
  页面上没有清空入口，清理只由条数上限自动完成

### 🔍 页面查询

- **三段精准匹配** — 标题 → 全拼 → 首字母，逐级尝试
- **拼音模糊匹配** — 打分排序（标题包含 / 全拼前缀 / 公共前缀等），最多返回 5 条
- **QQ 平台按钮** — QQ 会话下返回 markdown + 可点击按钮；其它平台返回纯文本
- **序号选择** — 非 QQ 平台列出候选并要求 15 秒内回复序号

### 🤖 AI 问答（Function Calling + mwn 实时取正文）

- **Function Calling** — DeepSeek 拿到 `search_oni_bwiki(keyword)` 工具后**自己决定查什么**，
  不再依赖本地语义检索；常规两轮模型调用
- **复用已有 mwn 实例取正文** — `WikiBotService.fetchPagePlainText()` 走 `action=parse&prop=text`，
  拿的是**模板/模块展开后**的 HTML，登录态失效会自动重登重放
- **cheerio 清洗保留信息框** — 信息框（右侧关键数值）抽成 `电力：消耗 120 瓦` 这样的「标签：值」行，
  正文数表压平为 `单元格 | 单元格`，只丢导航框 / 目录 / 脚本 / 脚注标记
- **关键词三级解析** — `wikipages` 精确标题 → 拼音/首字母模糊匹配 → BWiki 全文检索，
  最后才把关键词原样当标题试一次
- **防幻觉** — 第 2 轮把正文以 `role:'tool'` 回填，提示词要求「严格且仅根据资料回答」
- **强制检索** — 模型试图凭记忆作答时，程序会用 `tool_choice` 逼它再检索一次
- **追问** — 自己最近 2 轮问答会被带进上下文；开启 `aiChannelMemory` 时，群里刚聊过的词条也能被「耗电多少」这类**没有主语的追问**引用。
  **多人群聊不会串台**：问题里带新词条就零历史、独立检索（详见下方「群内承接」表格）
- **长回答折叠** — QQ 下回答超过 `aiCodeBlockMinChars`（默认 180 字）时整段塞进代码块，
  渲染成一张可复制的卡片，手机端不再刷屏；短回答仍走普通 markdown

> Wikitext 源码**只**用于同步，永远不会进入 AI 链路。AI 只看到渲染后的纯文本。
> 正文按页缓存 10 分钟（最多 50 页），群里反复问同一页不会重复请求 bwiki。

### 🔌 路由

- **短链跳转** — `/gg/:id`、`/bw/:id` 按数据库中的页面 ID 跳转
- **通配转发** — `/ggwiki/*` 转发任意路径与查询参数到原站（含路径遍历防护）

## 🚀 安装

```bash
npm install koishi-plugin-oni-sync-bot
# 或
yarn add koishi-plugin-oni-sync-bot
```

### AI 相关依赖

AI 问答只需要 `cheerio`（解析 `action=parse` 的 HTML），已随插件声明为 `dependencies`：

```bash
npm uninstall vectra @huggingface/transformers   # 0.12.0 起不再需要
```

> 从 0.11.x 升级时，这两个包（以及 `data/oni-vector`、`data/oni-models` 目录）
> 都可以直接删掉：本地推理与向量索引已经移除，省下约 **180 MB 内存**与 **300 MB 安装体积**。

### 依赖服务

插件需要以下 Koishi 插件（通常已随 Koishi 提供）：

- `@koishijs/plugin-database`（`wikipages` / `oniaimemory` / `sync_*` 持久化）
- `@koishijs/plugin-server`（短链路由）
- `@koishijs/plugin-console`（控制台同步运维页面）
- `@koishijs/plugin-http`（调用 DeepSeek 接口）
- 任意适配器（可选；QQ 适配器才能看到 markdown 按钮效果）

> **定时任务不依赖 `koishi-plugin-cron`**：插件内置了 `ctx.oniCron` 调度器
> （`src/utils/cron.ts` + `src/services/cronScheduler.ts`），随插件一起加载。
> 从旧版本升级时可以把 `koishi.yml` 里的 `cron:xxxxxxxx: {}` 删掉。

## ⚙️ 配置项

配置 schema 的**唯一声明处**是 [`src/config.ts`](src/config.ts)，分为六个分组：账号、站点、通知、定时任务、增量同步、AI 问答。

| 参数                  | 分组     | 说明                                                    | 默认值                         |
| --------------------- | -------- | ------------------------------------------------------- | ------------------------------ |
| `ggUsername`          | 账号     | GG 原站用户名                                           | `1`                            |
| `ggPassword`          | 账号     | GG 原站密码                                             | `1`                            |
| `bwikiusername`       | 账号     | bwiki 用户名                                            | `1`                            |
| `bwikipassword`       | 账号     | bwiki 密码                                              | `1`                            |
| `domain`              | 站点     | 短链域名（用于生成按钮与提示里的链接）                  | `klei.vip`                     |
| `main_site`           | 站点     | 主站域名（GG 原站）                                     | `oxygennotincluded.wiki.gg/zh` |
| `bwiki_site`          | 站点     | 镜像站域名（bwiki）                                     | `wiki.biligame.com/oni`        |
| `notifyGroupIds`      | 通知     | 增量同步成功后通知的群频道 ID 列表；留空则不通知        | `[]`                           |
| `notifyBotPlatform`   | 通知     | 发送通知所用的 bot 平台标识                             | `qq`                           |
| `updateCron`          | 定时     | 页面缓存自动更新的 cron 表达式                          | `0 2 * * *`（每天 02:00）      |
| `syncCron`            | 增量同步 | 增量同步 cron（**只能改 `koishi.yml`，面板只读**）      | `15 * * * *`（每小时第 15 分） |
| `syncLogLimit`        | 增量同步 | 最近更改记录的保留条数（超出自动裁掉最旧的）            | `5000`                         |
| `syncCheckImages`     | 增量同步 | 是否在增量同步时比对图片                                | `true`                         |
| `syncMaxPagesPerRun`  | 增量同步 | 单轮最多同步的页面数，超出部分由水位游标留到下一轮      | `300`                          |
| `syncMaxImagesPerRun` | 增量同步 | 单轮最多同步的图片数                                    | `100`                          |
| `syncOverlapSeconds`  | 增量同步 | 拉取起始时间向前偏移的秒数（抵消 MediaWiki 写入延迟）   | `10`                           |
| `syncFallbackHours`   | 增量同步 | 首次运行（尚无水位）时向前回溯的小时数                  | `24`                           |

### 🤖 AI 相关配置

`aiEnabled` / `deepseek*` / `aiMemory*` 这几项仍然生效：

| 参数                  | 分组 | 说明                                                          | 默认值                     |
| --------------------- | ---- | ------------------------------------------------------------- | -------------------------- |
| `aiEnabled`           | AI   | 启用 `.ai` 命令                                               | `true`                     |
| `deepseekApiKey`      | AI   | DeepSeek API Key（也可用环境变量 `DEEPSEEK_API_KEY`）          | 空                         |
| `deepseekBaseUrl`     | AI   | API 地址                                                      | `https://api.deepseek.com` |
| `deepseekModel`       | AI   | 模型名（需支持 Function Calling，`deepseek-chat` 支持）         | `deepseek-chat`            |
| `aiTemperature`       | AI   | 采样温度                                                      | `0.2`                      |
| `aiMaxTokens`         | AI   | 单次回答最大 token                                            | `700`                      |
| `aiTimeout`           | AI   | 请求超时（毫秒）                                              | `60000`                    |
| `aiCooldown`          | AI   | 同一用户提问冷却（秒）                                        | `5`                        |
| `aiMaxQuestionLength` | AI   | 问题最大长度                                                  | `200`                      |
| `aiMemoryTurns`       | AI   | 追问记忆保留的轮数（0 = 关闭）                                | `2`                        |
| `aiMemoryTtl`         | AI   | 追问记忆过期时间（秒），超时视为新话题                        | `600`                      |
| `aiChannelMemory`     | AI   | 群内话题承接：别人刚问过，自己接着问也能懂「那它…」            | `true`                     |
| `aiCodeBlockMinChars` | AI   | QQ 下回答超过这么多字就塞进代码块（`0` = 始终不用）            | `180`                      |

> **已删除的配置（0.12.5 起 schema 中不再存在）**：
> `textSyncOnChange`、`textApiUrl`、`textTableMode`、`textMaxLength`、`textSyncInterval`，
> 以及整组向量配置 `vectorEnabled`、`vectorIndexPath`、`embeddingModel`、`embeddingDtype`、
> `embeddingCacheDir`、`embeddingRemoteHost`、`chunkSize`、`chunkOverlap`、`maxChunksPerPage`、
> `retrieveTopK`、`retrieveMinScore`、`queryInstruction`、`embedBatchSize`。
> 旧 `koishi.yml` 里残留这些键不会报错（schema 中已无这些键，程序也不再读取），但控制台不会再显示，可以放心删掉。

> **默认值形同虚设**：账号默认值是 `1`，必须改成真实账号，否则登录一定失败。

## 📚 命令列表

> 命令名**不区分大小写**；下表中的「命令」是注册时的规范名称。

### 🔍 查询

| 命令                | 别名      | 说明                                | 权限 |
| ------------------- | --------- | ----------------------------------- | ---- |
| `x <itemName:text>` | `/查wiki` | 查询页面（标题 / 全拼 / 首字母）    | -    |
| `ai <question:text>`| `/问缺氧` | 基于 BWIKI 资料的 AI 问答（工具调用）| -    |
| `ai.status`         | -         | 查看 AI / BWiki 客户端状态          | 1    |

> 部署顺序：先 `update` 把页面列表拉进 `wikipages`（`.ai` 的关键词→标题解析依赖它，
> 缺失时也能工作，只是会退化到 BWiki 全文检索）。
>
> 正文不再预热、不再建索引：每次提问按需通过 mwn 取一次，**结果缓存 10 分钟**。
> bwiki 的 WAF 要求带 `Referer`，mwn 客户端已内置，无需额外配置。
>
> **追问**：`.ai` 会按「平台 + 频道 + 用户」记住最近 2 轮（默认 10 分钟内有效）。
> 先问「电解器耗电多少」，再问「那它能干什么」时，历史问答会一起送给模型，
> 模型据此把「它」解析成「电解器」再去检索。
>
> **群内承接**（`aiChannelMemory`，默认开）：群里刚聊过某个词条时，**他人的提问也能被没有主语的追问引用**。
> 触发条件很严格，因此多人交替聊天不会串台：
>
> | 提问 | 是否使用历史 | 结果 |
> | --- | --- | --- |
> | A：`电解器是干什么的` | 无历史 | 检索电解器，群话题 = 电解器 |
> | B：`水泵有什么用` | **不使用** | 检索水泵，群话题 = 水泵 |
> | C：`电解器耗多少电` | **不使用** | 检索电解器，群话题 = 电解器 |
> | D：`水泵机制` | **不使用** | 检索水泵，群话题 = 水泵 |
> | E：`耗电多少` | 承接 D 的「水泵机制」 | 沿用上一轮页面水泵 |
>
> 判定规则：**只有问题本身没有主语**（「耗电多少」「那它能干什么」）或**点名了最近话题**
> （「电解器的材料呢」）时才加载历史；问题里带新词条就零历史、独立检索——
> 自己上一问的历史同样按这条规则处理，换话题时不回放。
>
> 回放时也有区别：群内话题**只回放「问的是什么」**（包成一条注明「不是当前问题」的提示），
> 别人的答案正文绝不会进模型；自己的历史答案压缩成 200 字摘要。
> 答「未提及」或没查到页面的轮次不会成为群话题。
> `💭 承接群内上一问：…` 只在本轮**真的复用了上一轮页面**时出现。
>
> 记忆会**落库**（`oniaimemory` 表），Koishi 重启、热重载后依然能承接上一问；过期行按 `aiMemoryTtl` 自动清理。
> `aiMemoryTurns=0` 可整体关闭。
>
> **长回答不刷屏**：QQ 的 markdown 消息里，代码块会渲染成一张可复制的卡片。因此回答超过
> `aiCodeBlockMinChars`（默认 180 字）时整段放进代码块，正文里的 `**加粗**`、`### 标题`、
> `- 列表` 会先被换成 `•` 之类的纯文本（代码块不渲染 markdown），承接标注与数据来源留在块外。
> 想让所有回答都用普通 markdown，把它设为 `0`。

### 🧠 2G 内存够不够

0.12.0 起 AI 链路不再加载任何本地模型，内存占用回到基线：

| 阶段 | RSS |
| ---- | --- |
| Koishi + sqlite + http 基线 | 约 103 MB |
| 一次问答（mwn 抓 1 页 + cheerio 解析 + 正文缓存 3 KB） | 峰值增加 < 20 MB |
| 旧方案（q8 Embedding 模型 + 1 万块向量索引常驻） | 282 MB |

- 正文缓存上限 **50 页 × 3 KB ≈ 150 KB**，可以忽略；
- `Model`、`onnxruntime` 相关依赖已移除，Windows 上也不会再有 DLL 问题；
- 真正的成本变成 **DeepSeek token**：一次问答通常 2 次调用，正文 3000 字 ≈ 2.5k token。

> 想再省一点：把 `aiMaxTokens` 调到 `500`，并保持 `aiMemoryTurns=2`（记忆本身几乎不占内存）。

**2G Windows Server 推荐档**：

| 参数 | 建议值 |
| ---- | ------ |
| `aiMaxTokens` | `600` |
| `aiCooldown` | `5`（防刷，顺带减少 token 消耗） |
| `aiMemoryTurns` | `2` |
| `aiChannelMemory` | `true` |

另外两点务必做：

1. **Windows 虚拟内存（页面文件）保持 ≥ 2GB**，给 Node 的 GC 留出余量；
2. `.ai` 的瓶颈已经是 DeepSeek 的响应时间，与同步任务撞车只会让回答慢几秒，不再需要错峰。

### 🔄 同步

| 命令                        | 别名       | 说明                 | 权限 |
| --------------------------- | ---------- | -------------------- | ---- |
| `sync.incrementalUpdate`    | `增量更新` | 手动触发一次增量同步（与自动调度同一条链路） | 1 |
| `sync.status`               | -          | 查看各任务状态、进度、下次定时 | 1 |
| `sync <pageTitle:string>`   | -          | 同步单个页面到 bwiki | 4    |
| `sync.allpages`             | -          | 同步所有页面         | 4    |
| `sync.module <moduleTitle>` | -          | 同步单个模块         | 4    |
| `sync.allmodules`           | -          | 同步所有模块         | 4    |
| `sync.img <imgTitle>`       | -          | 同步单张图片         | 4    |
| `sync.allimgs`              | -          | 同步所有图片         | 4    |
| `sync.contributor <title>`  | -          | 同步指定页面的贡献者 | 4    |
| `sync.allcontributors`      | -          | 同步所有页面的贡献者 | 4    |

> 增量同步是安全、幂等的低风险操作，权限只要 **1**；
> 全量 / 单页同步会大量写入 bwiki，统一收紧到 **4**。

#### 增量同步是怎么跑的

1. **水位**：`sync_config.last_sync_time` 记录**上次完整跑完**的时间；首次运行没有水位时回溯 `syncFallbackHours`（默认 24 小时）。
2. **水位体检（自动补漏）**：水位必须 ≥ `sync_logs` 里最新一条记录的时间。
   如果水位反而更靠后（历史 bug 把水位推到了「现在」、时钟回拨、手改配置），
   会先在 `(记录时间, 水位]` 这段空隙里浅探 1 条变更：**确实有漏更就把窗口回退到记录处补齐**。
   这样「水位跳过一段没人拉过的区间」这种永久漏更不可能再发生。
3. **拉页面变更**：`list=recentchanges`，区间 `[窗口起点, 现在]`，正序（旧→新），
   只取 `rcnamespace=0` 且 `rctype=edit|new`（排除非主命名空间与删除日志）。
   向前偏移 10 秒（`syncOverlapSeconds`）是为了抵消 MediaWiki 的写入延迟，宁可重复也不漏。
   本轮 0 条时会把**源站最新一条变更**打出来，方便区分「确实没人编辑」和「被命名空间/类型过滤掉」。
4. **记录最近更改**：每条变更按 `rcid` 去重写入 `sync_logs`（同页多次编辑只同步一次页面，但记录都保留），
   超过 `syncLogLimit` 时自动裁掉最旧的。
5. **同步页面**：去重后的标题逐个走原有的 `PageSyncer.syncOne()`（内容相同会直接跳过），顺带补 `wikipages` 与贡献者。
6. **同步图片**：图片不进 `recentchanges`，所以先用 `list=allimages&aiprop=timestamp` 拿一份轻量索引，
   与 `sync_images` 指纹比对找出「新图片 / 时间戳变了」的，再用 `prop=imageinfo`（50 个一批）确认，逐个走 `ImageSyncer.syncOne()`。
7. **推进水位**：跑完 → 水位 = 本轮结束时间；
   若被 `syncMaxPagesPerRun` 截断 → 水位停在「最后处理页面的最早一次编辑」这个游标上，下一轮从那里继续。
   中途**暂停/停止**不推进水位（下次重跑这段区间，靠 rcid 去重与内容比对几乎零成本）。

> **群通知**：页面与图片的**成功同步**会合并成一条消息推到 `notifyGroupIds`（图片以 `🖼️` 标记、只标时间）。
> 「内容相同跳过」不算同步成功，不会推送，避免刷屏。

#### 任务优先级与并发

同一时刻**只允许一个同步任务真正执行**（2C2G 上并发只会互相拖慢），冲突时按优先级让路：

| 场景 | 行为 |
| ---- | ---- |
| 增量同步要跑（定时到点 / 权限 1 的命令），全量任务正在跑 | 全量任务**自动暂停**并让路，增量跑完后可手动「继续」 |
| 增量同步正在跑，去启动全量任务 | **拒绝**（增量优先级最高，不可被抢占） |
| 全量 A 正在跑，启动了全量 B | A 自动暂停并让路，B 开始；A 之后可「继续」 |
| 对已暂停的任务点「开始」 | 等价于「继续」 |

### 📝 缓存与登录

| 命令                                     | 别名       | 说明                            | 权限 |
| ---------------------------------------- | ---------- | ------------------------------- | ---- |
| `update`                                 | -          | 从原站拉取页面列表更新本地缓存  | 2    |
| `update.status`                          | -          | 查询缓存条目数量                | 1    |
| `update.delete`                          | -          | 清空页面缓存                    | 4    |
| `redirect <pageName> <targetPageName>`   | `重定向`   | 在原站创建 `#REDIRECT` 页面     | 2    |
| `relogin`                                | `重新登录` | 手动重新登录两个站点            | 2    |

> 以上之外还有 4 个命令来自 Koishi 核心插件而非本插件：`help`、`status`、`clear`、`command`。

## ⏰ 定时任务

调度由插件内置的 `ctx.oniCron`（`src/services/cronScheduler.ts`）负责，**不再依赖 `koishi-plugin-cron`**。
表达式支持 5 段（分 时 日 月 周）与 6 段（秒 分 时 日 月 周，兼容旧写法），
本地时区，`ctx.setTimeout` 排期（插件卸载时自动清理）。

| cron           | 时间            | 任务                    | 说明                                            |
| -------------- | --------------- | ----------------------- | ----------------------------------------------- |
| `15 * * * *`   | 每小时第 15 分  | **增量同步**            | 由 `syncCron` 决定，**只能改 `koishi.yml`**，面板里只显示 |
| `0 2 * * *`    | 每天 02:00      | 页面缓存自动更新        | 由 `updateCron` 配置，默认值如左                |
| `0 0 2 * * 0`  | 每周日 02:00    | 同步所有贡献者          | —                                               |

> 全量页面 / 全量图片 / 全量模块**不参与定时**，只能在同步运维面板（控制台首页 `/`）手动开始（权限 4）。
> 增量同步的表达式写死在配置里，控制台不提供修改入口，避免运行时改 cron 与排期打架。
> 表达式写错时只记一条错误日志并跳过该任务，不会影响插件启动。
> 需要查看已注册的任务与下次触发时间，可在控制台调试里执行 `ctx.oniCron.list()`。

## 🔌 路由接口

| 路径        | 方法               | 说明                                                        |
| ----------- | ------------------ | ----------------------------------------------------------- |
| `/gg/:id`   | GET                | 跳转至 `main_site` 对应页面（标题自动编码，附带 `?variant=zh`） |
| `/bw/:id`   | GET                | 跳转至 `bwiki_site` 对应页面                                |
| `/ggwiki/*` | 任意（`server.use`）| 原样转发到 `main_site`，保留查询参数；带路径遍历与字符校验   |

`/gg/:id` 与 `/bw/:id` 的 `:id` 是**数据库中的页面 ID**，不是标题。首次部署请先执行 `update` 填充缓存，否则会返回「未找到ID为【…】的页面」。

## 🗄️ 数据库模型

| 表名        | 字段                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| `wikipages` | `id`、`title`、`pinyin_full`、`pinyin_first`、`contributor`、`change_time`                                       |
| `oniaimemory` | `id`（主键=记忆键）、`payload`（JSON）、`updated_at`（毫秒时间戳）                                       |
| `sync_logs` | `id`（主键 = rcid）、`title`、`user`、`timestamp`（ISO）、`comment`、`sizeDiff`、`diffHtml`、`revid`、`parentid`、`ns` |
| `sync_config` | `key`（主键）、`value` —— 存 `last_sync_time` / `last_result:<任务>`                                            |
| `sync_images` | `title`（主键）、`timestamp`、`sha1`、`synced_at` —— 图片增量比对用的指纹                                     |

`wikipages` / `oniaimemory` / `sync_*` 通过 `Tables` 接口增强声明（见 `databaseExtension.ts`）。

> 0.12.0 起不再维护 `wikitexts` 表（渲染文本改为按需抓取），0.12.5 起连表声明也移除了。
> 0.14.0 起不再有 `onitodos` 表（TodoList 功能已移除）。
> 0.17.0 起不再有 `onilogs` 表（日志中心页面已被「同步运维」取代）。
> 旧库里的这三张表不会被自动删除，但插件**不会再读写它们**，可以自行
> `DROP TABLE wikitexts` / `DROP TABLE onitodos` / `DROP TABLE onilogs` 回收空间。

## 🎨 控制台界面

插件在 Koishi 控制台注册两个页面（见 [`client/index.ts`](client/index.ts)）：

| 页面       | 路径          | 源码位置                   | 功能                                        |
| ---------- | ------------- | -------------------------- | ------------------------------------------- |
| 同步运维   | `/`（首页）   | `client/onisync/`          | 任务卡片 + 进度 + 最近更改列表（diff 抽屉）  |
| 火箭计算器 | `/calculator` | `client/Rocketcalculator/` | ONI 火箭设计计算器                          |

### 同步运维面板

页面对应后端 `src/plugins/syncConsole.ts`，控制台事件：

| 事件           | 权限 | 说明                                              |
| -------------- | ---- | ------------------------------------------------- |
| `sync/status`  | 0    | 四个任务的状态 / 进度 + 下次增量 + 水位 + 统计     |
| `sync/logs`    | 0    | 分页 / 关键词查询最近更改                          |
| `sync/detail`  | 0    | 单条详情，`diffHtml` 为空时实时抓取并缓存          |
| `sync/control` | 4    | `{ taskId, action }`，`start` / `pause` / `resume` / `stop` |

- **没有 `update-cron`**：增量同步的表达式只来自配置，页面只展示
- **没有清空接口**：最近更改只能查，旧记录由 `syncLogLimit` 自动裁剪
- 状态推走 DataService `onisync`（轻量快照，进度 400ms 节流），列表按需 `send` 拉取
- diff 用 `difftype=unified` 拉取后在客户端按行着色（`+` 绿 / `-` 红 / `@@` 紫），
  比整表 HTML 小一个数量级，也不会出现左右两栏重复显示的问题


## 📦 项目结构

```
src/
├── index.ts                  # 组合根：SUB_PLUGINS 注册表 + 控制台入口
├── config.ts                 # 配置的唯一声明处（账号 / 站点 / 通知 / 定时 / AI）
├── services/
│   ├── wikiBotService.ts     # wikiBot 服务：登录、代理、透明重登录、fetchPagePlainText
│   ├── cronScheduler.ts      # 内置 cron 调度器（ctx.oniCron）
│   ├── aiService.ts          # DeepSeek 客户端（Function Calling）+ 两套提示词
│   ├── aiMemory.ts           # 追问记忆（用户 / 群话题）与上下文选择
│   ├── messageRenderer.ts    # QQ markdown+按钮 / 纯文本 的渲染
│   ├── syncRepository.ts     # 水位 / 最近更改 / 图片指纹的持久化
│   └── syncTaskManager.ts    # 多任务状态机 + 协作式取消令牌（pausable / stoppable）
├── plugins/
│   ├── cronService.ts        # 挂载 ctx.oniCron
│   ├── databaseExtension.ts  # wikipages / oniaimemory / sync_* 表定义
│   ├── syncConsole.ts        # 同步运维面板：任务控制 / 最近更改（ctx.syncConsole）
│   ├── queryCommands.ts      # x / 查wiki
│   ├── aiQueryCommands.ts    # ai / ai.status（Agent 调度）
│   ├── syncCommands.ts       # sync.* 命令 + 贡献者定时任务
│   ├── updateCommands.ts     # update.* / redirect / relogin
│   └── routeRedirect.ts      # 短链路由
├── sync/
│   ├── pageSync.ts           # PageSyncer：单页 / 全量（原子能力，不含调度）
│   ├── incrementalSync.ts    # 增量引擎：recentchanges + 图片指纹 + 水位推进
│   ├── moduleSync.ts         # ModuleSyncer：模块同步
│   └── imgSync.ts            # ImageSyncer：图片同步
└── utils/
    ├── tools.ts              # 拼音、时间格式化、标题规范化、站点 URL 规范化等
    ├── cron.ts               # cron 表达式解析与下次触发时间（纯函数，可单测）
    ├── renderText.ts         # HTML → 纯文本（纯函数，可单测）
    ├── async.ts              # sleep + withRetry（全项目统一的重试语义）
    └── matcher.ts            # 查询打分与模糊匹配（纯函数，可单测）

tests/                        # 单元测试
client/                       # 控制台前端（Vue）
```

## 🧩 架构与扩展

### 组合根

[`src/index.ts`](src/index.ts) 是唯一的组合根。它按**依赖顺序**注册一组子插件：

```
CronService（提供 oniCron 调度器，必须最先）
  ↓
DatabaseExtension（声明数据表）
  ↓
WikiBotService（提供 wikiBot 服务：登录 + 取正文）
  ↓
SyncConsole（提供 syncConsole：四个同步任务 + 最近更改 + 控制台数据源）
  ↓
RouteRedirect / SyncCommands / QueryCommands / UpdateCommands / AiQueryCommands
```

所有子插件共享**同一个配置对象**，因此注册时统一传 `config`；不需要配置的子插件会忽略它。

### AI 数据流

```
.ai 提问
   ↓  第 1 轮（tools + tool_choice:'auto'）
DeepSeek 决定调用 search_oni_bwiki(keyword)
   ↓
wikipages 精确标题 → 拼音/首字母模糊 → BWiki 全文检索 → 关键词原样当标题
   ↓
WikiBotService.fetchPagePlainText(title)
   ├─ mwn.parseTitle(title, { prop:'text', redirects:true, ... })   ← 模板/模块已展开
   ├─ extractPlainText(html, { tableMode:'flatten', maxLength:3000 })
   └─ 进程内缓存 10 分钟 / 最多 50 页
   ↓  第 2 轮（tools + tool_choice:'none'，role:'tool' 回填正文）
DeepSeek 生成回答 ──> QQ / 纯文本 + 数据来源
```

关键约束：

| 规则 | 原因 |
| --- | --- |
| 每个 `tool_call` 都必须回一条 `role:'tool'` | 少一条，下一次请求会被服务端判为 400 |
| 第 2 轮传 `tools` 但 `tool_choice:'none'` | 消息结构对各家兼容层都合法，同时禁止再调工具 |
| 最多执行 2 个检索 | 比较类问题够用；更多会导致延迟与 token 翻倍 |
| 模型不调工具时用 `tool_choice:'required'` 强制一次 | 防止它凭记忆作答（缺氧数值极易记错） |
| 清洗不删 `<table>` | bwiki 的信息框就是 `table.infobox`，删了等于把耗电/产热/尺寸删掉 |

> 抽取器优先保留信息框：`电解器` 抽出 2637 字，含 `电力：消耗 120 瓦`、`过热：75°C`；
> `氧石精炼炉` 抽出 939 字，含 `电力：消耗 1200 瓦`、`建造时间：480 秒`。
> 若把表格全删，这两页会掉到 586 / 2620 字且**不含任何数值**。

### 如何新增一个子插件

1. 新建一个类，用 `static readonly inject` 声明它依赖哪些服务（例如 `["database", "wikiBot"]`）；
2. 把它加进 `src/index.ts` 的 `SUB_PLUGINS` 数组；
3. 如果需要配置，在 `src/config.ts` 的**对应分组**里补字段，再用 `Pick` / `extends` 引用。

```ts
// src/plugins/myFeature.ts
import { Context } from "koishi";
import type { SiteConfig } from "../config";

export class MyFeature {
  public static readonly inject = ["database"];
  constructor(ctx: Context, public config: Pick<SiteConfig, "domain">) {
    // ...
  }
}
```

```ts
// src/index.ts —— 只改这一行
const SUB_PLUGINS = [/* ... */, MyFeature] as const;
```

> ⚠️ **不要**在子插件里重复声明已有的配置键。所有键只在 `src/config.ts` 声明一次，重复声明会在 `Schema.intersect` 合并时产生"同一字段多份"，且后者静默覆盖前者。

### 如何新增一条命令

在对应子插件的 `registerCommands()` 里链式调用即可：

```ts
ctx.command("my.cmd <arg:string>", "说明", { authority: 2 })
  .alias("我的命令")
  .action(async ({ session }, arg) => {
    return "回复内容";
  });
```

要点：

- `session` 可能是 `undefined`（命令也可能被控制台/程序化调用），发送消息请用 `session?.send(...)`；
- `.option()` 声明过的选项在 action 里请用解构默认值 `options = {}`，避免 `undefined`；
- 回复内容用 `return` 即可；需要按平台渲染时用 `MessageRenderer`。

### 如何新增同步逻辑

`src/sync/` 下的三个类都是 `(source, target, deps?)` 的统一构造签名，选项通过 `deps.options` 注入并有默认值。新增一种同步器请沿用该形状，不要引入模块级可变状态。

## 🧪 测试与开发

本仓库**只有** `test` 脚本：

```bash
yarn test        # tsc 编译到 .test-build/，再用 mocha 跑
```

测试用 `tsc` 进程内编译 + `mocha` 单进程加载，**不依赖 esbuild / ts-node**。

> `yarn build` 与 `yarn dev` 来自 **Koishi 实例根**，不在本仓库 —— 本插件按 Koishi 约定的
> workspace 方式放在实例的 `external/` 目录下，由实例的 yakumo 统一构建。

## 🔒 安全与权限

| 操作 | 权限 |
| ---- | ---- |
| 增量同步（命令 / 自动调度） | **1** |
| 查看同步状态、最近更改 | 0 ~ 1 |
| 全量 / 单页 / 单图 / 贡献者同步命令 | **4** |
| 控制台里的开始 / 暂停 / 继续 / 停止 | **4** |
| 清空页面缓存（`update.delete`） | **4** |

- 账号密码只保存在 Koishi 配置中，不写入日志
- 登录过期由 `WikiBotService` 内部的代理透明处理，自动重登后重放原请求
- `/ggwiki/*` 做了路径遍历（`..`）与非法字符校验

## 🐛 故障排查

**`❌ WikiBotService 初始化失败，两个 Wiki 均无法登录`**
检查 `ggUsername` / `ggPassword` / `bwikiusername` / `bwikipassword`。默认值 `1` 是占位符。
可执行 `relogin` 手动重试。注意短时间内反复失败会触发服务端限流，需等待约 5 分钟。

**`❌ 本地缓存为空，请联系管理员执行【update】指令更新缓存！`**
执行 `update` 从原站拉取页面列表。

**`❌ 未找到ID为【…】的页面`**
页面不在本地缓存中（可能是新增页面），先执行 `update`。

**`.ai` 一直回答「抱歉，资料中未提及相关信息」**
1. 执行 `ai.status`，确认「BWiki 客户端」是 ✅；显示 ❌ 时先 `relogin`（`.ai` 取正文完全依赖 mwn 登录态）；
2. 「本地页面缓存」为 0 说明没跑过 `update`——此时仍能用，只是关键词→标题会退化到 BWiki 全文检索，建议补跑 `update`；
3. 确认问句里有具体名词（如「电解器耗电多少」而不是「耗电多少」），追问依赖记忆承接才能补全主语；
4. 看日志里 `[ai] Agent 决定检索:` 那行实际抓的是哪一页：
   - 抓到的是**别的页面** → 关键词解析偏了，把问句写得更接近页面标题；
   - 显示 **未找到** → 该词条在 bwiki 上确实没有对应页面（或未登录）。

**`.ai` 拿上一轮的资料回答了不相关的问题**
0.12.6 起已修复：只有当问题自己没有主语（「耗电多少」）或点名上一轮页面时才沿用上一轮资料。
如果仍出现，把日志里对应的两行贴出来——
`[ai] 关键词「…」自带新实体且无对应页面，不使用上一轮资料（…）` 表示判定生效，
而 `[ai] 追问「…」未命中新页面，沿用上一轮: …` 表示这次被判定为追问。

**`.ai` 报「AI 服务暂时不可用」**
日志里会带 DeepSeek 的 HTTP 状态与 message。常见原因：Key 无效、余额不足、
模型名不支持 Function Calling（必须用 `deepseek-chat`，`deepseek-reasoner` 不支持 tools）。

**`ai.status` 显示 BWiki 客户端 ❌**
bwiki 登录失败。检查 `bwikiusername` / `bwikipassword`，执行 `relogin` 重试；
短时间内反复失败会触发限流，需等约 5 分钟。

**`sync` / `update` 命令在控制台里「消失」了**
这些子插件依赖 `wikiBot` / `database` / `console`。若一个必需服务没就绪，整组命令都不会注册。排查：
1. 控制台日志里是否有 `WikiBotService 初始化失败`；
2. 是否安装了 `@koishijs/plugin-http`（`.ai` 需要）。

> 定时任务已内置（`ctx.oniCron`），与 `koishi-plugin-cron` 无关；
> 若启动日志出现「内置 cron 调度器未就绪」，通常是子插件注册顺序被改动了。

**内存占用偏高**
- 0.12.0 起已不再加载本地模型，RSS 应回到 100~130 MB；若仍偏高，检查是否还装着旧版插件目录；
- `data/oni-vector`、`data/oni-models` 可以直接删掉（不再读写）；
- 仍不够时调小 `aiMaxTokens`、关掉 `aiChannelMemory`。

**QQ 下只显示纯文本**
markdown 与按钮依赖 `session.platform === "qq"`，请确认适配器正确上报平台。

## 📜 License

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。

## 📧 支持

如有问题，请在 GitHub 上提交 Issue，或访问 <https://klei.vip>。
