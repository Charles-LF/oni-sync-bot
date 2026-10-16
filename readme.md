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

### 依赖服务

插件需要以下 Koishi 插件（通常已随 Koishi 提供）：

- `@koishijs/plugin-database`（`wikipages` / `onitodos` 持久化）
- `@koishijs/plugin-server`（短链路由）
- `@koishijs/plugin-console`（控制台页面与日志查看）
- `koishi-plugin-cron`（定时任务）
- 任意适配器（可选；QQ 适配器才能看到 markdown 按钮效果）

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

> **默认值形同虚设**：账号默认值是 `1`，必须改成真实账号，否则登录一定失败。

## 📚 命令列表

> 命令名**不区分大小写**；下表中的「命令」是注册时的规范名称。

### 🔍 查询

| 命令                | 别名      | 说明                             | 权限 |
| ------------------- | --------- | -------------------------------- | ---- |
| `x <itemName:text>` | `/查wiki` | 查询页面（标题 / 全拼 / 首字母） | -    |

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
| `onitodos`  | `id`、`title`、`content`、`completed`、`createdBy`、`createdAt`、`updatedAt`                                     |

`wikipages` 通过 `Tables` 接口增强声明（见 `databaseExtension.ts`）；`onitodos` 目前**没有**做接口增强。

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
├── config.ts                 # 配置的唯一声明处（账号 / 站点 / 通知 / 定时 四组）
├── services/
│   ├── wikiBotService.ts     # wikiBot 服务：登录、代理、透明重登录
│   ├── messageRenderer.ts    # QQ markdown+按钮 / 纯文本 的渲染
│   └── consoleLogProvider.ts # 控制台日志服务（onilogs）
├── plugins/
│   ├── databaseExtension.ts  # wikipages 表定义
│   ├── queryCommands.ts      # x / 查wiki
│   ├── syncCommands.ts       # sync.* 命令 + 同步相关定时任务
│   ├── updateCommands.ts     # update.* / redirect / relogin
│   ├── routeRedirect.ts      # 短链路由
│   └── todoList.ts           # TodoList 命令 + 控制台监听 + 定时任务
├── sync/
│   ├── pageSync.ts           # PageSyncer：单页 / 全量 / 增量更新
│   ├── moduleSync.ts         # ModuleSyncer：模块同步
│   └── imgSync.ts            # ImageSyncer：图片同步
└── utils/
    ├── tools.ts              # 拼音、时间格式化、标题规范化等
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
ConsoleLogProvider / DatabaseExtension（提供 console 数据源与数据表）
  ↓
RouteRedirect / SyncCommands / QueryCommands / UpdateCommands / TodoList
```

所有子插件共享**同一个配置对象**，因此注册时统一传 `config`；不需要配置的子插件会忽略它。

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

**QQ 下只显示纯文本**
markdown 与按钮依赖 `session.platform === "qq"`，请确认适配器正确上报平台。

## 📜 License

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。

## 📧 支持

如有问题，请在 GitHub 上提交 Issue，或访问 <https://klei.vip>。
