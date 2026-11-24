# koishi-plugin-oni-sync-bot

[![npm](https://img.shields.io/npm/v/koishi-plugin-oni-sync-bot?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-oni-sync-bot)
[![Koishi](https://img.shields.io/badge/koishi-plugin-42b983?style=flat-square)](https://koishi.chat)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**缺氧 Wiki 镜像站同步机器人插件** — 把 [oxygennotincluded.wiki.gg](https://oxygennotincluded.wiki.gg)（下称 **GG 原站**）的内容**单向镜像**到 B站 Wiki（下称 **bwiki**），并提供拼音页面查询、短链接跳转与通配转发。

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
- **任务详情抽屉** — 点任务卡片查看本次运行：成功 / 跳过 / 失败条目（含具体原因）+ 完整日志流，
  运行中日志通过 `sync/log` 广播**实时滚动**，落库后仍可回看（默认每次保留 500 条、最近 20 次运行）
- **忽略规则页** — 直接在页面上增删「页面 / 图片 / 模块」级别的跳过规则，改动即时生效
- **最近更改只读** — 落库的 `recentchanges` 列表（默认保留 5000 条），可检索、分页、点开看 unified diff；
  页面上没有清空入口，清理只由条数上限自动完成

### 🔍 页面查询

- **四级精准匹配** — 标题（原样）→ 全拼 → 首字母 → 标题（忽略大小写），逐级尝试；
  英文页面 `x sandbox` 也能命中 `Sandbox`
- **拼音重码给候选** — `pinyin_full` 重码很常见（`jidi` 既是「极地」也是「基地」），
  命中多页时按标题排序后全部列出来让用户选，不再随机取第一条
- **拼音模糊匹配** — 打分排序（标题包含 / 全拼前缀 / 公共前缀等），最多返回 5 条
- **QQ 平台按钮** — QQ 会话下返回 markdown + 可点击按钮；其它平台返回纯文本
- **序号选择只认本人** — 非 QQ 平台列出候选并等 15 秒；只接受**提问者本人**在同一频道的回复，
  群友随口发一句不会被当成序号吞掉；`3abc` / `3.5` 这类输入直接判无效
- **页面列表缓存 60 秒** — `wikipages` 只在 `update` 时变，重复查询不再每次读全表

### 🔌 路由

- **短链跳转** — `/gg/:id`、`/bw/:id` 按数据库中的页面 ID 跳转
- **通配转发** — `/ggwiki/*` 转发任意路径与查询参数到原站（含路径遍历防护）

## 🚀 安装

```bash
npm install koishi-plugin-oni-sync-bot
# 或
yarn add koishi-plugin-oni-sync-bot
```

### 依赖服务

插件需要以下 Koishi 插件（通常已随 Koishi 提供）：

- `@koishijs/plugin-database`（`wikipages` / `sync_*` 持久化）
- `@koishijs/plugin-server`（短链路由）
- `@koishijs/plugin-console`（控制台同步运维页面）
- 任意适配器（可选；QQ 适配器才能看到 markdown 按钮效果）

> **定时任务不依赖 `koishi-plugin-cron`**：插件内置了 `ctx.oniCron` 调度器
> （`src/utils/cron.ts` + `src/infrastructure/sync/cronScheduler.ts`），随插件一起加载。
> 从旧版本升级时可以把 `koishi.yml` 里的 `cron:xxxxxxxx: {}` 删掉。

## ⚙️ 配置项

配置 schema 的**唯一声明处**是 [`src/config.ts`](src/config.ts)，分为五个分组：账号、站点、通知、定时任务、增量同步。

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
| `syncTaskLogLimit`    | 增量同步 | 任务详情每次运行保留的日志条数（超出裁掉最早的）        | `500`                          |
| `syncRunKeep`         | 增量同步 | 任务详情保留最近多少次运行（含条目与日志）              | `20`                           |

> **默认值形同虚设**：账号默认值是 `1`，必须改成真实账号，否则登录一定失败。

> **已删除的 AI 配置（0.20.0 / 0.21.0 起 schema 中不再存在）**：`aiEnabled`、`deepseekApiKey`、
> `deepseekBaseUrl`、`deepseekModel`、`aiTemperature`、`aiMaxTokens`、`aiTimeout`、`aiCooldown`、
> `aiMaxQuestionLength`、`aiMemoryTurns`、`aiMemoryTtl`、`aiChannelMemory`、`aiCodeBlockMinChars`、
> `aiMaxToolRounds`、`aiSelfCheck`、`aiChatLogLimit`。
> 旧 `koishi.yml` 里残留这些键不会报错（schema 中已无这些键，程序也不再读取），可以放心删掉。

## 📚 命令列表

> 命令名**不区分大小写**；下表中的「命令」是注册时的规范名称。

### 🔍 查询

| 命令                | 别名      | 说明                                            | 权限 |
| ------------------- | --------- | ----------------------------------------------- | ---- |
| `x <itemName:text>` | `/查wiki` | 查询页面（标题 / 全拼 / 首字母），返回链接 + 按钮 | -    |

> 部署顺序：先 `update` 把页面列表拉进 `wikipages`（标题 / 全拼 / 首字母匹配依赖它，
> 缺失时会退化到 BWiki 全文检索）。
>
> `.ai` 问答已移除（0.20.0），提问一律走上面这条确定性的查询链路：
> 命中就回「页面链接 + QQ 按钮」，没命中就给候选列表让用户选序号。

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
| `sync.ignore.add <type> <name> [reason]` | `忽略添加` | 添加忽略规则（`page` / `image` / `module`，名称支持 `*`） | 4 |
| `sync.ignore.remove <type> <name>` | `忽略移除` | 移除忽略规则 | 4 |
| `sync.ignore.list [type]`   | `忽略列表` | 查看忽略规则 | 4 |

> 增量同步是安全、幂等的低风险操作，权限只要 **1**；
> 全量 / 单页同步会大量写入 bwiki，统一收紧到 **4**。

#### 忽略规则（数据库驱动）

跳过名单不再写死在代码里：`sync_ignore` 表 + 控制台「忽略规则」页 + 上面三条命令共用同一个用例
（`application/sync/ignoreListUseCase.ts`）。

- 名称归一化：忽略大小写、首尾空白、`_` 视作空格；图片去掉 `File:` / `文件:` 前缀，模块去掉 `Module:` 前缀
- 支持 `*` 通配，例如 `File:Icon_*`、`教程*`
- 三种类型分别匹配：`page` 不影响 `image`，反之亦然
- 命中后条目记为「跳过」，原因写进任务详情；内置名单（`教程` / `首页` 等）仍然兜底
- 规则在**每次任务开始前**加载一次，循环里只做内存匹配
- **内置规则只补种一次**：`domain/sync/defaultIgnores.ts` 里带一份初始名单（`.ico` 与超过体积上限的 GIF），
  启动时按 `IGNORE_SEED_VERSION` 判断是否已经补过；同版本重启不会再塞，管理员删掉的规则不会复活。
  当前这一版补种的是 `Favicon.ico`、`Site-favicon.ico`、`EX1-453222.gif`、`EX1-456658.gif`、
  `EX1-462129.gif`、`U37-482255.gif`、`U51-594211.gif`

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

调度由插件内置的 `ctx.oniCron`（`src/infrastructure/sync/cronScheduler.ts`）负责，**不再依赖 `koishi-plugin-cron`**。
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
| `sync_logs` | `id`（主键 = rcid）、`title`、`user`、`timestamp`（ISO）、`comment`、`sizeDiff`、`diffHtml`、`revid`、`parentid`、`ns` |
| `sync_config` | `key`（主键）、`value` —— 存 `last_sync_time` / `last_result:<任务>`                                            |
| `sync_images` | `title`（主键）、`timestamp`、`sha1`、`synced_at` —— 图片增量比对用的指纹                                     |
| `sync_ignore` | `id`（自增主键）、`type`（page/image/module）、`name`、`normalized`（归一化后的查重列）、`reason`、`createdAt` |
| `sync_runs` | `id`（主键）、`taskId`、`trigger`、`state`、`startedAt`、`finishedAt`、`message`、`total`/`synced`/`skipped`/`failed` |
| `sync_run_items` | `id`（`runId#seq`）、`runId`、`title`、`action`（synced/skipped/failed）、`reason`、`at`                   |
| `sync_run_logs` | `id`（`runId#seq`）、`runId`、`level`（info/warn/error）、`message`、`at`                                   |

`wikipages` / `sync_*` 通过 `Tables` 接口增强声明（见 `databaseExtension.ts`）。
`sync_runs` / `sync_run_items` / `sync_run_logs` 是任务详情抽屉的数据源，
`syncRunKeep` 控制保留多少次运行、`syncTaskLogLimit` 控制每次运行保留的日志条数。

> 0.12.0 起不再维护 `wikitexts` 表（渲染文本改为按需抓取），0.12.5 起连表声明也移除了。
> 0.14.0 起不再有 `onitodos` 表（TodoList 功能已移除）。
> 0.17.0 起不再有 `onilogs` 表（日志中心页面已被「同步运维」取代）。
> 0.20.0 起不再有 `oniaimemory` 表（`.ai` 问答已移除，追问记忆随之消失）。
> 0.21.0 起不再有 `ai_chat_logs` 表（AI 运营面板一并移除）。
> 旧库里的这些表不会被自动删除，但插件**不会再读写它们**，可以自行
> `DROP TABLE wikitexts` / `DROP TABLE onitodos` / `DROP TABLE onilogs` /
> `DROP TABLE oniaimemory` / `DROP TABLE ai_chat_logs` 回收空间。

## 🎨 控制台界面

插件在 Koishi 控制台注册两个页面（见 [`client/index.ts`](client/index.ts)）：

| 页面       | 路径          | 源码位置                   | 功能                                        |
| ---------- | ------------- | -------------------------- | ------------------------------------------- |
| 同步运维   | `/`（首页）   | `client/onisync/`          | 任务卡片 + 进度 + 最近更改列表（diff 抽屉）  |
| 火箭计算器 | `/calculator` | `client/Rocketcalculator/` | ONI 火箭设计计算器                          |

### 同步运维面板

页面对应后端 `src/interface/syncConsole.ts`，控制台事件：

| 事件           | 权限 | 说明                                              |
| -------------- | ---- | ------------------------------------------------- |
| `sync/status`  | 0    | 四个任务的状态 / 进度 + 下次增量 + 水位 + 统计     |
| `sync/logs`    | 0    | 分页 / 关键词查询最近更改                          |
| `sync/detail`  | 0    | 单条详情，`diffHtml` 为空时实时抓取并缓存          |
| `sync/taskDetail` | 0 | 一次运行的条目（成功 / 跳过 / 失败）与完整日志     |
| `sync/ignore/list` | 0 | 忽略规则列表                                   |
| `sync/ignore/add` | 4 | 添加忽略规则                                     |
| `sync/ignore/remove` | 4 | 移除忽略规则                                  |
| `sync/control` | 4    | `{ taskId, action }`，`start` / `pause` / `resume` / `stop` |
| `sync/log`（广播） | 0 | 运行中的实时日志，前端用 `ctx.on("sync/log")` 订阅 |

- **没有 `update-cron`**：增量同步的表达式只来自配置，页面只展示
- **没有清空接口**：最近更改只能查，旧记录由 `syncLogLimit` 自动裁剪
- 状态推走 DataService `onisync`（轻量快照，进度 400ms 节流），列表按需 `send` 拉取
- 任务日志走 `SyncRunRecorder`：先入内存缓冲、每 400ms 合并落库，同时 `broadcast` 给网页；
  任务生命周期（启动 / 暂停 / 完成 / 停止）也走同一个 `sync/log` 通道，`ctx.logger` 只在启动与致命错误时出现
- diff 用 `difftype=unified` 拉取后在客户端按行着色（`+` 绿 / `-` 红 / `@@` 紫），
  比整表 HTML 小一个数量级，也不会出现左右两栏重复显示的问题

## 📦 项目结构

```
src/
├── index.ts                  # 组合根：SUB_PLUGINS 注册表 + 控制台入口
├── config.ts                 # 配置的唯一声明处（账号 / 站点 / 通知 / 定时 / 同步）
├── domain/                   # 领域层：纯 TS，不依赖 Koishi / mwn / 数据库
│   └── sync/
│       ├── ignoreRule.ts     # 忽略规则值对象 + 归一化 + 通配匹配
│       ├── decision.ts       # 同步三态判定（synced / skipped / failed）与是否跳过
│       ├── ports.ts          # SyncReporter 端口 + reportSyncItem
│       └── runToken.ts       # 协作式取消令牌（RunToken / SyncAbortedError）
├── application/              # 应用层：用例编排
│   └── sync/
│       ├── incrementalSyncUseCase.ts  # 增量同步用例（水位 / 拉变更 / 同步页面与图片）
│       ├── fullSyncUseCase.ts         # 全量同步用例（页面 / 图片 / 模块）
│       ├── ignoreListUseCase.ts       # 忽略列表增删查（校验 / 归一化 / 查重）
│       ├── syncTypes.ts               # 任务状态 / 进度 / 汇总类型
│       └── syncStatePort.ts           # 水位 / 变更记录 / 图片指纹的仓储端口
├── infrastructure/           # 基础设施层：仓储与外部输出
│   ├── wiki/                 # wikiBot 服务：登录 / 代理 / 透明重登录 / fetchPagePlainText
│   ├── persistence/          # databaseExtension（表定义）+ 仓储
│   │   ├── databaseExtension.ts
│   │   ├── syncRepository.ts      # 水位 / 最近更改 / 图片指纹（实现 SyncStatePort）
│   │   ├── syncIgnoreRepository.ts
│   │   ├── syncRunRepository.ts   # sync_runs / items / logs 读写与裁剪
│   ├── console/
│   │   └── syncRunRecorder.ts     # 日志缓冲落库 + sync/log 广播
│   ├── notify/syncNotifier.ts     # 同步成功后的群通知
│   └── sync/                      # 任务状态机（syncTaskManager）、内置 cron（cronScheduler）
├── interface/                # 接口层：Koishi 命令与控制台 API
│   ├── cronService.ts        # 挂载 ctx.oniCron
│   ├── syncConsole.ts        # 同步运维面板：任务控制 / 最近更改 / 忽略规则
│   ├── queryCommands.ts      # x / 查wiki
│   ├── syncCommands.ts       # sync.* 命令 + 贡献者定时任务
│   ├── updateCommands.ts     # update.* / redirect / relogin
│   ├── routeRedirect.ts      # 短链路由
│   └── messageRenderer.ts    # QQ markdown+按钮 / 纯文本 的渲染
├── sync/                     # 纯执行器：只搬数据，不判断业务
│   ├── pageSync.ts           # PageSyncer：单页 / 全量
│   ├── incrementalSync.ts    # 兼容层，转导出 application 层的用例
│   ├── moduleSync.ts         # ModuleSyncer：模块同步
│   ├── imgSync.ts            # ImageSyncer：图片同步
│   └── hooks.ts              # 循环钩子（暂停 / 停止 / 进度 / 日志 / 条目）
└── utils/
    ├── tools.ts              # 拼音、时间格式化、标题规范化、站点 URL 规范化等
    ├── cron.ts               # cron 表达式解析与下次触发时间（纯函数，可单测）
    ├── renderText.ts         # HTML → 纯文本（纯函数，可单测）
    ├── async.ts              # sleep + withRetry（全项目统一的重试语义）
    └── matcher.ts            # 查询打分与模糊匹配（纯函数，可单测）

tests/                        # 单元测试
client/shared/                # 前端共用：rpc 薄封装、时间格式化、抽屉样式
client/onisync/               # 同步运维前端
├── dashboard.vue             # 首页组合：概览 / 任务卡片 / 最近更改
├── components/
│   ├── TaskDetailDrawer.vue  # 任务详情抽屉（条目列表 + 实时日志）
│   ├── ChangeDiffDrawer.vue  # 最近更改 diff 抽屉
│   └── IgnoreRulePanel.vue   # 忽略规则维护
└── format.ts / rpc.ts / types.ts
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
RouteRedirect / SyncCommands / QueryCommands / UpdateCommands
```

所有子插件共享**同一个配置对象**，因此注册时统一传 `config`；不需要配置的子插件会忽略它。

### 分层（整洁架构）与迁移阶段

目录按依赖方向分层：`domain` ← `application` ← `infrastructure` / `plugins`。

| 层 | 目录 | 职责 | 允许依赖 |
| --- | --- | --- | --- |
| Domain | `src/domain/` | 实体、值对象、业务判定（忽略规则匹配、同步三态判定）、取消令牌 | 无 |
| Application | `src/application/` | 用例编排（增量同步、全量同步、忽略列表）、任务状态类型 | domain |
| Infrastructure | `src/infrastructure/` | 仓储实现、wiki 客户端、日志落库与广播、任务状态机 | domain / application |
| Interface | `src/interface/`、`client/` | Koishi 命令、控制台 API、Vue 组件 | 全部 |

迁移是分阶段的，**不推翻重写**：

- **P0（已完成）** 建立 domain / application / infrastructure；把「是否跳过 / 是否同步」上移到领域层（`decideIgnore` / `classifySyncResult`）；增量同步迁到 `application/sync/incrementalSyncUseCase.ts`，`sync/incrementalSync.ts` 只做转导出。
- **P1（已完成）** Page / Image / Module 执行器只做执行与上报；`SyncReporter` 端口把日志交给 `SyncRunRecorder`，`ctx.logger` 只留致命错误与启动信息。
- **P2（已完成）** 忽略列表改为数据库驱动，命令与控制台 API 共用 `IgnoreListUseCase`。
- **P3（已完成）** `plugins/` → `interface/`；`wikiBotService` → `infrastructure/wiki`；仓储与表定义 → `infrastructure/persistence`；`src/services` 目录已移除。
- **P4（已完成）** 全量同步收敛成 `FullSyncUseCase`；`SyncConsole` 只剩「装配依赖 + 接运行记录器 + 注册事件」。
- **P5（已完成）** 前端拆成 `client/onisync/components/*`（任务详情 / diff / 忽略规则）+ 共享 `format` / `rpc` / `types` / 样式。
- **P6（已完成，后整体回退）** 曾新增 AI 问答与 AI 运营面板；**0.20.0 / 0.21.0 把整条 AI 链路（问答 + 面板 + `ai_chat_logs` + `oniaimemory`）全部移除**，回到不依赖模型的确定性查询。

> 后续可选（未排期）：把 `syncTaskManager` 拆成「领域令牌 + 基础设施调度」两个更小的类。

### 查询数据流（`x` / `查wiki`）

```
x 电解器
   ↓
标题（原样）→ 全拼 → 首字母 → 标题（忽略大小写）→ 拼音/首字母模糊打分（最多 5 条）
   ↓
命中一页：MessageRenderer 输出 markdown + 可点击按钮（QQ）
          └─ 按钮走 /gg/:id、/bw/:id 短链，直接跳到 GG 原站 / bwiki 对应页面
命中多页：按标题排序后全部列出（QQ 给按钮，其它平台等 15 秒序号，只认提问者本人）
未命中：提示「按标准名称重查」或「页面可能还没同步，请管理员 update」
```

> 整条链路不经过任何模型，结果**确定**：同一个关键词每次给同样的链接与按钮。

### 如何新增一个子插件

1. 新建一个类，用 `static readonly inject` 声明它依赖哪些服务（例如 `["database", "wikiBot"]`）；
2. 把它加进 `src/index.ts` 的 `SUB_PLUGINS` 数组；
3. 如果需要配置，在 `src/config.ts` 的**对应分组**里补字段，再用 `Pick` / `extends` 引用。

```ts
// src/interface/myFeature.ts
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

**`x` / `查wiki` 说「未找到」**
1. 「本地页面缓存」为 0 说明没跑过 `update`，先执行 `update`；
2. 关键词尽量贴近页面标题（`x 电解器` 而不是 `x 电解器耗电多少`）；也可以直接用全拼 / 首字母（`x dianjieqi`）；
3. 页面列表缓存 60 秒，刚 `update` 完最多等 1 分钟再查；
4. 仍然命中不了但页面确实存在 → 说明它还没同步进来，查日志里的同步结果。

**`sync` / `update` 命令在控制台里「消失」了**
这些子插件依赖 `wikiBot` / `database` / `console`。若一个必需服务没就绪，整组命令都不会注册。排查：
1. 控制台日志里是否有 `WikiBotService 初始化失败`；
2. 数据库插件是否正常加载。

> 定时任务已内置（`ctx.oniCron`），与 `koishi-plugin-cron` 无关；
> 若启动日志出现「内置 cron 调度器未就绪」，通常是子插件注册顺序被改动了。

**内存占用偏高**
- 0.12.0 起已不再加载本地模型，0.20.0 / 0.21.0 又把整条 AI 链路移除，RSS 应回到 100~130 MB；
  若仍偏高，检查是否还装着旧版插件目录；
- `data/oni-vector`、`data/oni-models` 可以直接删掉（不再读写）。

**QQ 下只显示纯文本**
markdown 与按钮依赖 `session.platform === "qq"`，请确认适配器正确上报平台。

## 📜 License

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。

## 📧 支持

如有问题，请在 GitHub 上提交 Issue，或访问 <https://klei.vip>。
