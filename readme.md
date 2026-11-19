# koishi-plugin-oni-sync-bot

[![npm](https://img.shields.io/npm/v/koishi-plugin-oni-sync-bot?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-oni-sync-bot)
[![Koishi](https://img.shields.io/badge/koishi-plugin-42b983?style=flat-square)](https://koishi.chat)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**缺氧 Wiki 镜像站同步机器人插件** — 把 [oxygennotincluded.wiki.gg](https://oxygennotincluded.wiki.gg)（下称 **GG 原站**）的内容**单向镜像**到 B站 Wiki（下称 **bwiki**），并提供拼音页面查询、模块同步待办管理、短链接跳转与通配转发。

> 同步方向是 **GG 原站 → bwiki 单向**，不会把 bwiki 的改动回写原站。

## ✨ 核心功能

### 📄 Wiki 同步

- **双站点登录** — 同时登录 GG 原站与 bwiki，登录失败自动重试（3 次，间隔 5 秒）
- **透明重登录** — 请求过程中一旦发现登录态失效（`assert=user`），自动重新登录并**重放该请求**，调用方无感知
- **页面同步** — 单个页面 / 全量页面
- **模块同步** — `Module:` 命名空间页面（含 `Dev:` → `Module:Dev/` 路径映射）
- **图片同步** — 下载原站图片并上传到 bwiki，支持 SHA1 比对跳过与旧版本清理
- **贡献者同步** — 单页 / 全量同步贡献者与最后修改时间
- **增量更新** — 每小时取最近 3 小时的 `recentchanges` 并同步

### 🔍 页面查询

- **三段精准匹配** — 标题 → 全拼 → 首字母，逐级尝试
- **拼音模糊匹配** — 打分排序（标题包含 / 全拼前缀 / 公共前缀等），最多返回 5 条
- **QQ 平台按钮** — QQ 会话下返回 markdown + 可点击按钮；其它平台返回纯文本
- **序号选择** — 非 QQ 平台列出候选并要求 15 秒内回复序号

### 🤖 AI 问答（本地向量检索 + DeepSeek）

- **渲染文本抽取** — 同步成功后调用 BWiki `action=parse&prop=text` 取渲染结果，用 cheerio 清洗：
  **信息框（右侧的关键数值）抽成 `电力：消耗 1200 瓦` 这样的「标签：值」行**，
  正文数表压平为 `单元格 | 单元格`，导航框 / 目录 / 脚本 / 脚注标记才丢弃，结果写入 `wikitexts` 表
- **本地向量库** — 纯 TS 的 [vectra](https://github.com/Stevenic/vectra) 文件索引，不引入任何数据库进程
- **本地 Embedding** — `@huggingface/transformers` 在 CPU 上跑 `bge-small-zh-v1.5`（默认 q8 量化），不依赖外部 Embedding API
- **防幻觉** — 检索片段进 system 提示词，模型被要求「严格且仅根据资料回答，资料未提及就直接说未提及」
- **追问** — 自己最近 2 轮问答会被带进上下文；开启 `aiChannelMemory` 时，别人刚问过的题目也能承接（「那它耗电多少」）
- **话题页补全** — 问题点名的页面（或命中集中的页面）会把整页交给模型，并始终带上信息框那一块，
  回答不再只覆盖页面开头（详见 [AI 数据流](#ai-数据流)）
- **降级检索** — 向量库不可用（未启用 / 还没建索引 / 模型加载失败）时，退化为既有的拼音标题匹配，再取该页正文

> Wikitext 源码**只**用于同步，永远不会进入 AI 检索链路。AI 只看到渲染后的纯文本。

### 📋 模块同步 TodoList

- **自动纳管** — 每周一 00:00 拉取原站全部 Module 写入待办
- **状态检查** — 每周二 00:00 对比两侧修订时间，自动标记完成 / 未完成
- **控制台界面** — 搜索、筛选、分页、增删改查
- **权限** — 删除 / 清空需权限 2，清空页面缓存需权限 4

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

AI 问答功能依赖三个包（已随插件声明为 `dependencies`，正常安装即可）：

```bash
npm install vectra cheerio @huggingface/transformers
# 或
yarn add vectra cheerio @huggingface/transformers
```

| 包 | 用途 | 体积说明 |
| -- | ---- | -------- |
| `vectra` | 本地文件向量索引 | 纯 JS，无独立进程 |
| `cheerio` | 解析 `action=parse` 返回的 HTML | 纯 JS |
| `@huggingface/transformers` | 本地 CPU 推理 Embedding 模型 | 含 onnxruntime，约 300MB 安装体积 |

首次运行 `ai.sync` / `ai.reindex` 时会从 `embeddingRemoteHost`（默认 `https://hf-mirror.com`）下载模型，
`bge-small-zh-v1.5` 的 q8 量化模型约 25MB，缓存在 `embeddingCacheDir`。

> 运行环境：`vectra@0.15` 声明 `engines: node >= 22`，建议使用 **Node 22 / 24**（本仓库测试环境为 Node 26）。
> 2 核 2G 的机器建议保持 `embeddingDtype="q8"`、`embedBatchSize=4`，Embedding 常驻内存约 100~200MB。

### 依赖服务

插件需要以下 Koishi 插件（通常已随 Koishi 提供）：

- `@koishijs/plugin-database`（`wikipages` / `wikitexts` / `onitodos` 持久化）
- `@koishijs/plugin-server`（短链路由）
- `@koishijs/plugin-console`（控制台页面与日志查看）
- `@koishijs/plugin-http`（`.ai` 抓取 BWiki 渲染文本、调用 DeepSeek）
- `koishi-plugin-cron`（定时任务，**可选**：未启用时 `sync.*` / `update` / `todolist` 命令照常可用，
  只是不会自动跑增量同步等定时任务，启动时会打一条警告）
- 任意适配器（可选；QQ 适配器才能看到 markdown 按钮效果）

> 若需要定时任务，请在 `koishi.yml` 里补一项（插件名 `cron`）：
>
> ```yaml
> plugins:
>   group:basic:
>     cron:xxxxxxxx: {}
> ```

## ⚙️ 配置项

配置 schema 的**唯一声明处**是 [`src/config.ts`](src/config.ts)，分为四个分组：账号、站点、通知、定时任务。

| 参数                | 分组 | 说明                                     | 默认值                         |
| ------------------- | ---- | ---------------------------------------- | ------------------------------ |
| `ggUsername`        | 账号 | GG 原站用户名                            | `1`                            |
| `ggPassword`        | 账号 | GG 原站密码                              | `1`                            |
| `bwikiusername`     | 账号 | bwiki 用户名                             | `1`                            |
| `bwikipassword`     | 账号 | bwiki 密码                               | `1`                            |
| `domain`            | 站点 | 短链域名（用于生成按钮与提示里的链接）   | `klei.vip`                     |
| `main_site`         | 站点 | 主站域名（GG 原站）                      | `oxygennotincluded.wiki.gg/zh` |
| `bwiki_site`        | 站点 | 镜像站域名（bwiki）                      | `wiki.biligame.com/oni`        |
| `logsUrl`           | 通知 | 日志查看地址，出现在命令回复里           | `https://klei.vip/onilogs`     |
| `notifyGroupIds`    | 通知 | 增量更新成功后通知的群频道 ID 列表；留空则不通知 | `[]`                    |
| `notifyBotPlatform` | 通知 | 发送通知所用的 bot 平台标识              | `qq`                           |
| `updateCron`        | 定时 | 页面缓存自动更新的 cron 表达式           | `0 2 * * *`（每天 02:00）      |

### 🤖 AI 相关配置

| 参数                  | 分组     | 说明                                                         | 默认值                              |
| --------------------- | -------- | ------------------------------------------------------------ | ----------------------------------- |
| `textSyncOnChange`    | 渲染文本 | 同步成功后自动抓取渲染文本并写索引                           | `true`                              |
| `textApiUrl`          | 渲染文本 | BWiki 的 `api.php` 地址                                      | 空（由 `bwiki_site` 拼出）          |
| `textTableMode`       | 渲染文本 | `flatten` 保留信息框+压平数据表 / `drop` 丢弃全部表格（会丢数值） | `flatten`                           |
| `textMaxLength`       | 渲染文本 | 单页最多保留字数                                             | `20000`                             |
| `textSyncInterval`    | 渲染文本 | 批量抓取时的页间间隔（毫秒）                                 | `300`                               |
| `vectorEnabled`       | 向量     | 启用本地向量库                                               | `true`                              |
| `vectorIndexPath`     | 向量     | vectra 索引目录                                              | `data/oni-vector`                   |
| `embeddingModel`      | 向量     | 本地 Embedding 模型                                          | `Xenova/bge-small-zh-v1.5`          |
| `embeddingDtype`      | 向量     | `q8` / `fp32` / `fp16` / `q4`                                | `q8`                                |
| `embeddingCacheDir`   | 向量     | 模型缓存目录                                                 | `data/oni-models`                   |
| `embeddingRemoteHost` | 向量     | 模型下载源                                                   | `https://hf-mirror.com`             |
| `chunkSize`           | 向量     | 单块目标字数                                                 | `350`                               |
| `chunkOverlap`        | 向量     | 相邻块重叠字数                                               | `60`                                |
| `maxChunksPerPage`    | 向量     | 单页最多块数（决定索引体积，2G 建议 12）                     | `16`                                |
| `retrieveTopK`        | 向量     | 全局检索返回块数（信息框数值常排第 4，建议 5；话题页补全另算） | `5`                                 |
| `retrieveMinScore`    | 向量     | 最低余弦相似度                                               | `0.2`                               |
| `queryInstruction`    | 向量     | BGE 查询指令前缀                                             | `为这个句子生成表示以用于检索相关文章：` |
| `embedBatchSize`      | 向量     | 单批 Embedding 条数                                          | `4`                                 |
| `aiEnabled`           | AI       | 启用 `.ai` 命令                                              | `true`                              |
| `deepseekApiKey`      | AI       | DeepSeek API Key（也可用环境变量 `DEEPSEEK_API_KEY`）         | 空                                  |
| `deepseekBaseUrl`     | AI       | API 地址                                                     | `https://api.deepseek.com`          |
| `deepseekModel`       | AI       | 模型名                                                       | `deepseek-chat`                     |
| `aiTemperature`       | AI       | 采样温度                                                     | `0.2`                               |
| `aiMaxTokens`         | AI       | 回答最大 token                                               | `700`                               |
| `aiTimeout`           | AI       | 请求超时（毫秒）                                             | `60000`                             |
| `aiCooldown`          | AI       | 同一用户提问冷却（秒）                                       | `5`                                 |
| `aiMaxQuestionLength` | AI       | 问题最大长度                                                 | `200`                               |
| `aiMemoryTurns`       | AI       | 追问记忆保留的轮数（0 = 关闭）                               | `2`                                 |
| `aiMemoryTtl`         | AI       | 追问记忆过期时间（秒），超时视为新话题                       | `600`                               |
| `aiChannelMemory`     | AI       | 群内话题承接：别人刚问过，自己接着问也能懂「那它…」           | `true`                              |

> **默认值形同虚设**：账号默认值是 `1`，必须改成真实账号，否则登录一定失败。

## 📚 命令列表

> 命令名**不区分大小写**；下表中的「命令」是注册时的规范名称。

### 🔍 查询

| 命令                | 别名      | 说明                             | 权限 |
| ------------------- | --------- | -------------------------------- | ---- |
| `x <itemName:text>` | `/查wiki` | 查询页面（标题 / 全拼 / 首字母） | -    |
| `ai <question:text>`| `/问缺氧` | 基于 BWIKI 资料的 AI 问答         | -    |
| `ai.status`         | -         | 查看 AI / 向量索引状态           | 1    |
| `ai.sync [pageTitle]` | -       | 抓取渲染文本（不填则全量）       | 4    |
| `ai.reindex`        | -         | 用本地正文重建向量索引           | 4    |

> 首次部署顺序：`update`（拉页面列表）→ `ai.sync`（抓渲染文本 + 建索引）；
> 之后每小时增量同步会自动维护文本与索引，无需再手动执行。
>
> `ai.sync` 不依赖 `update`：本地 `wikipages` 为空时会自动改用 bwiki 的 `list=allpages` 枚举页面。
> 抓取时优先走已登录的 bwiki 客户端（mwn，自带 Referer/Cookie）；退回 `ctx.http` 时也会自动补 `Referer`——
> 缺少 `Referer` 会被 bwiki 的 WAF 以 **HTTP 567** 拦掉。
>
> **追问**：`.ai` 会按「平台 + 频道 + 用户」记住最近 2 轮（默认 10 分钟内有效）。
> 先问「电解器耗电多少」，再问「那它能干什么」时，上一轮的问题会被并入检索串，模型也能从历史里知道「它」指谁。
>
> **话题页补全**：确定话题页后（问题里点名的页面 → 上一轮记忆 → 命中集中的页面），
> 该页的**第 0 块（信息框/简介）**一定钉进上下文——耗电、产热、尺寸这些单点数值在相似度排序里
> 只排第 4~5，靠排名召回很脆弱。点名的页面或宽泛问题会把**整页**交给模型（预算 5000 字 / 12 块），
> 所以「电解器能干哈」这种问题也能拿到信息框、建造、工作条件、技巧，而不是只看到开头一段；
> 追问则只补该页最相关的 3 块，保持聚焦。
>
> **群内承接**（`aiChannelMemory`，默认开）：自己还没提问记录时，会承接**群里上一条被回答的问题**。
> 比如 alice 问「氧石精炼炉是什么」，bob 接着问「那他耗电多少」，bob 这一问会以「氧石精炼炉是什么」为语境检索，
> 回复里会附一行 `💭 承接群内上一问：…` 说明依据；答「未提及」的轮次不会成为群话题。
>
> 记忆会**落库**（`oniaimemory` 表），Koishi 重启、热重载后依然能承接上一问；过期行按 `aiMemoryTtl` 自动清理。
> `aiMemoryTurns=0` 可整体关闭。

### 🧠 2G 内存够不够（实测数据）

在本机（Windows / Node 26 / q8 量化模型）分段实测 RSS：

| 阶段 | RSS |
| ---- | --- |
| Koishi + sqlite + http + cron 基线 | 103 MB |
| 加载 `bge-small-zh` q8 Embedding 模型后 | 216 MB（模型约占 113 MB） |
| 再挂 1 万个文本块的索引（`index.json` 81 MB），检索后常驻 | 282 MB |
| 释放模型后 | 255 MB（onnxruntime 的原生内存不一定立刻归还系统） |

> 建索引的过程中会有临时峰值（实测写入 1 万块时到过 376 MB，含构建批量数组的开销），
> 所以 `ai.sync` / `ai.reindex` 尽量低峰执行。

结论与经验值：

- **索引常驻内存 ≈ 每个文本块 6~7 KB**（384 维 float）；1 万块 ≈ 66 MB，3 万块 ≈ 200 MB。
- 索引体积取决于「页面数 × 单页块数」，所以 `maxChunksPerPage` / `textMaxLength` 就是内存阀门。
- 模型只在第一次问答时才加载（之后常驻），不会影响普通同步命令。

> **改过 `renderText` / `textTableMode` 之后必须重跑 `ai.sync`**：
> `wikitexts` 里存的是**已抽好的纯文本**，`ai.reindex` 只会用旧文本重建向量，不会重新抓页面。
>
> 只改**切块参数**（`chunkSize` / `chunkOverlap` / `maxChunksPerPage` / `retrieveTopK` / `retrieveMinScore`）时，
> 执行 `ai.reindex` 即可，无需重新抓取。

**2G Windows Server 推荐档**（`ai.status` 里「索引体积」超过 150 MB 时按此收紧）：

| 参数 | 建议值 |
| ---- | ------ |
| `textMaxLength` | `8000` |
| `maxChunksPerPage` | `12` |
| `chunkSize` / `chunkOverlap` | `350` / `60` |
| `embedBatchSize` | `2` |
| `aiMemoryTurns` | `2`（记忆本身很小，不用关） |

另外两点务必做：

1. **Windows 虚拟内存（页面文件）保持 ≥ 4GB**，避免瞬时峰值直接 OOM；
2. `ai.sync` / `ai.reindex` 不要和「同步所有页面」、定时任务撞车，放在低峰跑；
3. Windows Server 若加载模型时报 onnxruntime 相关的 DLL 错误，装一下 **Visual C++ 2015-2022 运行库**（x64）即可。

### 🔄 同步

| 命令                        | 别名       | 说明                 | 权限 |
| --------------------------- | ---------- | -------------------- | ---- |
| `sync <pageTitle:string>`   | -          | 同步单个页面到 bwiki | 2    |
| `sync.allpages`             | -          | 同步所有页面         | 2    |
| `sync.module <moduleTitle>` | -          | 同步单个模块         | 2    |
| `sync.allmodules`           | -          | 同步所有模块         | 2    |
| `sync.img <imgTitle>`       | -          | 同步单张图片         | 2    |
| `sync.allimgs`              | -          | 同步所有图片         | 2    |
| `sync.contributor <title>`  | -          | 同步指定页面的贡献者 | 2    |
| `sync.allcontributors`      | -          | 同步所有页面的贡献者 | 2    |
| `sync.incrementalUpdate`    | `增量更新` | 执行一次增量更新     | 2    |

### 📝 缓存与登录

| 命令                                     | 别名       | 说明                            | 权限 |
| ---------------------------------------- | ---------- | ------------------------------- | ---- |
| `update`                                 | -          | 从原站拉取页面列表更新本地缓存  | 2    |
| `update.status`                          | -          | 查询缓存条目数量                | 1    |
| `update.delete`                          | -          | 清空页面缓存                    | 4    |
| `redirect <pageName> <targetPageName>`   | `重定向`   | 在原站创建 `#REDIRECT` 页面     | 2    |
| `relogin`                                | `重新登录` | 手动重新登录两个站点            | 2    |

### ✅ TodoList

| 命令                     | 别名     | 说明                                     | 权限 |
| ------------------------ | -------- | ---------------------------------------- | ---- |
| `todolist`               | `todo`   | 跳转 TodoList 网页                       | -    |
| `todolist.list`          | `todo.l` | 同上                                     | -    |
| `todolist.add <title>`   | `todo.a` | 新增待办（`-c` 内容 / `-u` 创建人）      | -    |
| `todolist.edit <id>`     | `todo.e` | 编辑待办（`-t` 标题 / `-c` 内容 / `-u`） | -    |
| `todolist.complete <id>` | `todo.c` | 标记完成                                 | -    |
| `todolist.uncomplete <id>`| `todo.u`| 标记未完成                               | -    |
| `todolist.delete <id>`   | `todo.d` | 删除待办                                 | 2    |
| `todolist.clear`         | -        | 清空 TodoList                            | 2    |
| `todolist.syncmodules`   | -        | 手动把原站模块写入 TodoList              | -    |
| `todolist.checksync`     | -        | 手动检查模块同步状态                     | -    |

> 因为 `todolist` 的别名是 `todo`，Koishi 会把 `todo.list` 这类写法解析到 `todolist.list`，两种写法都能用。
>
> 另有 4 个命令来自 Koishi 核心插件而非本插件：`help`、`status`、`clear`、`command`。

## ⏰ 定时任务

| cron           | 时间            | 任务                    | 说明                                   |
| -------------- | --------------- | ----------------------- | -------------------------------------- |
| `15 * * * *`   | 每小时第 15 分  | 增量更新                | 同步最近 3 小时的编辑                  |
| `0 2 * * *`    | 每天 02:00      | 页面缓存自动更新        | 由 `updateCron` 配置，默认值如左       |
| `30 8 * * 3`   | 每周三 08:30    | 同步所有图片            | —                                      |
| `30 8 * * 4`   | 每周四 08:30    | 同步所有页面            | —                                      |
| `0 0 2 * * 0`  | 每周日 02:00    | 同步所有贡献者          | —                                      |
| `0 0 * * 1`    | 每周一 00:00    | 同步模块到 TodoList     | 拉取 `Module:` 命名空间页面写入待办     |
| `0 0 * * 2`    | 每周二 00:00    | 检查模块同步状态        | 对比两侧修订时间，自动标记完成 / 未完成 |

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
| `wikitexts` | `id`（主键=页面标题）、`title`、`pageid`、`revid`、`hash`、`text`、`updated_at`                                  |
| `oniaimemory` | `id`（主键=记忆键）、`payload`（JSON）、`updated_at`（毫秒时间戳）                                       |
| `onitodos`  | `id`、`title`、`content`、`completed`、`createdBy`、`createdAt`、`updatedAt`                                     |

`wikipages` / `wikitexts` / `oniaimemory` 通过 `Tables` 接口增强声明（见 `databaseExtension.ts`）；`onitodos` 目前**没有**做接口增强。

`wikitexts.text` 存的是 BWiki **渲染后的纯文本**（不是 Wikitext 源码），`hash` 是正文的 sha1，
用于在增量同步时跳过未变化的页面、避免重复 Embedding。

## 🎨 控制台界面

插件在 Koishi 控制台注册一个入口页与两个子页面（见 [`client/index.ts`](client/index.ts)）：

| 页面           | 源码位置                  | 功能                                        |
| -------------- | ------------------------- | ------------------------------------------- |
| 同步机器人首页 | `client/onilogs/`         | 查看 `oni-sync` 命名空间日志（最多保留 1000 条） |
| 缺氧 TodoList  | `client/onitodolist/`     | 待办的可视化增删改查                        |
| 火箭计算器     | `client/Rocketcalculator/`| ONI 火箭设计计算器                          |

## 📦 项目结构

```
src/
├── index.ts                  # 组合根：SUB_PLUGINS 注册表 + 控制台入口
├── config.ts                 # 配置的唯一声明处（账号 / 站点 / 通知 / 定时 / 渲染文本 / 向量 / AI）
├── services/
│   ├── wikiBotService.ts     # wikiBot 服务：登录、代理、透明重登录
│   ├── vectorService.ts      # vector 服务：本地 Embedding + vectra 索引（检索/写入）
│   ├── aiService.ts          # DeepSeek 客户端 + 防幻觉提示词组装
│   ├── aiMemory.ts           # 追问记忆（用户 / 群话题）与上下文选择
│   ├── messageRenderer.ts    # QQ markdown+按钮 / 纯文本 的渲染
│   └── consoleLogProvider.ts # 控制台日志服务（onilogs）
├── plugins/
│   ├── databaseExtension.ts  # wikipages / wikitexts 表定义
│   ├── queryCommands.ts      # x / 查wiki
│   ├── aiQueryCommands.ts    # ai / ai.status / ai.sync / ai.reindex
│   ├── syncCommands.ts       # sync.* 命令 + 同步相关定时任务 + 同步后抽取渲染文本
│   ├── updateCommands.ts     # update.* / redirect / relogin
│   ├── routeRedirect.ts      # 短链路由
│   └── todoList.ts           # TodoList 命令 + 控制台监听 + 定时任务
├── sync/
│   ├── pageSync.ts           # PageSyncer：单页 / 全量 / 增量更新（含 onSynced 钩子）
│   ├── textSync.ts           # RenderedTextSyncer：action=parse → 纯文本 → wikitexts → 向量库
│   ├── moduleSync.ts         # ModuleSyncer：模块同步
│   └── imgSync.ts            # ImageSyncer：图片同步
└── utils/
    ├── tools.ts              # 拼音、时间格式化、标题规范化、站点 URL 规范化等
    ├── renderText.ts         # HTML → 纯文本、文本切块（纯函数，可单测）
    ├── async.ts              # sleep + withRetry（全项目统一的重试语义）
    └── matcher.ts            # 查询打分与模糊匹配（纯函数，可单测）

tests/                        # 单元测试
client/                       # 控制台前端（Vue）
```

## 🧩 架构与扩展

### 组合根

[`src/index.ts`](src/index.ts) 是唯一的组合根。它按**依赖顺序**注册一组子插件：

```
WikiBotService（提供 wikiBot 服务，必须最先）
  ↓
VectorService（提供 vector 服务：本地 Embedding + 索引）
  ↓
ConsoleLogProvider / DatabaseExtension（提供 console 数据源与数据表）
  ↓
RouteRedirect / SyncCommands / QueryCommands / UpdateCommands / TodoList / AiQueryCommands
```

所有子插件共享**同一个配置对象**，因此注册时统一传 `config`；不需要配置的子插件会忽略它。

### AI 数据流

```
GG 原站 Wikitext ──(PageSyncer)──> bwiki
                                    │
                       (onSynced 钩子，同步成功后)
                                    ↓
        BWiki action=parse&prop=text ──> HTML ──(cheerio)──> 纯文本
                                    │
                     wikitexts 表（hash 去重）
                                    ↓
                 chunkText ──> bge-small-zh Embedding ──> vectra 索引
                                    ↓
                     .ai 提问 ──> 话题页判定 + 检索 ──> DeepSeek ──> QQ 回复
```

Wikitext 源码只用于同步，**不会**进入检索链路；`onSynced` 钩子的失败只记日志，不影响同步结果。

检索这一步会先定「话题页」，再决定给模型多少资料：

| 场景 | 话题页来源 | 交给模型的资料 |
| --- | --- | --- |
| 问题点名了页面（`氧石精炼炉怎么用`） | 问题里出现的页面标题（最长匹配，最多 2 个） | 该页**整页**（预算 5000 字 / 12 块）+ 其余检索命中 |
| 宽泛问题，命中集中在某页（`电解器能干哈`） | 本轮 5 块命中里过半来自同一页 | 同上 |
| 追问（`那它耗电多少`） | 上一轮记忆里的页面 | 第 0 块 + 该页最相关的 3 块（上限 `retrieveTopK + 2`） |

话题页的**第 0 块（信息框/简介）永远钉进上下文**：耗电、产热、尺寸这些单点数值在相似度排序里
只排第 4~5，靠排名召回太脆弱。

> 升级提示：`0.11.0` 之前的抽取器会把信息框当噪音丢掉。升级后执行一次 `ai.sync`
> （会重新抓取渲染文本，正文变化时自动重建该页的向量块），历史页面才会带上信息框数值。

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

- 所有写操作（同步页面 / 创建重定向 / 删除待办）需要权限 **2**
- 清空页面缓存需要权限 **4**
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
1. 执行 `ai.status`，确认「已入库页面」不是 0；为 0 时先执行 `ai.sync`（会自动枚举页面，也可先 `update` 补缓存）；
2. 「索引文本块」为 0 时执行 `ai.reindex`（索引被清空或模型刚就绪）；
3. 确认问句里有具体名词（如「电解器耗电多少」而不是「耗电多少」），追问依赖记忆承接才能补全主语；
4. 仍漏召回时调大 `retrieveTopK`（如 6）或调小 `retrieveMinScore`（如 0.15）。
   **信息框里的数值通常排在第 4 位左右**，`retrieveTopK=3` 时会正好被裁掉——这是 0.11.0 调整默认值的原因。

**`ai.sync` 报 HTTP 567 / 返回一串 HTML**
bwiki 的 WAF 拦截。抓取请求必须带 `Referer`（插件会自动补 `https://<bwiki_site>/`），
优先使用已登录的 bwiki 客户端；若仍被拦，先执行 `relogin` 再重试，或把 `textSyncInterval` 调大（如 1000）。

**`sync` / `update` / `todo` 命令在控制台里「消失」了**
这些子插件依赖 `wikiBot` / `database`，并把 `cron` 声明为**可选**依赖。
若一个必需服务没就绪，整组命令都不会注册。排查：
1. 控制台日志里是否有 `WikiBotService 初始化失败`；
2. 是否安装了 `@koishijs/plugin-http`（`.ai` 需要）；
3. 未启用 `koishi-plugin-cron` 只影响定时任务，会在启动日志里打一条黄色警告。

**模型下载失败 / 卡住**
`embeddingRemoteHost` 默认走 `https://hf-mirror.com`；若网络环境不同，可改为 `https://huggingface.co`，
或把模型文件手动放到 `embeddingCacheDir` 后把 `embeddingRemoteHost` 留空（离线）。

**内存占用偏高**
- 保持 `embeddingDtype="q8"`、调小 `embedBatchSize`；
- 调小 `maxChunksPerPage` / `textMaxLength` 以压缩索引体积（索引会整体载入内存）；
- `ai.status` 会显示「索引体积」，超过 150 MB 建议按上文的 2G 推荐档收紧后 `ai.reindex`。

**Windows 上加载模型报 onnxruntime / DLL 找不到**
安装 **Visual C++ 2015-2022 运行库（x64）**；另外确认页面文件（虚拟内存）足够大。

**QQ 下只显示纯文本**
markdown 与按钮依赖 `session.platform === "qq"`，请确认适配器正确上报平台。

## 📜 License

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。

## 📧 支持

如有问题，请在 GitHub 上提交 Issue，或访问 <https://klei.vip>。
