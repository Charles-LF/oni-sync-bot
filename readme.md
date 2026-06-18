# koishi-plugin-oni-sync-bot

[![npm](https://img.shields.io/npm/v/koishi-plugin-oni-sync-bot?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-oni-sync-bot)
[![Koishi](https://img.shields.io/badge/koishi-plugin-42b983?style=flat-square)](https://koishi.chat)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**缺氧 Wiki 镜像站同步机器人插件** — 实现 [oxygennotincluded.wiki.gg](https://oxygennotincluded.wiki.gg) 与 B站 Wiki 镜像的双向内容同步、拼音匹配页面查询、模块同步管理，以及页面短链接重定向服务。

## ✨ 核心功能

### 📄 Wiki 同步

- **双向登录** — 自动登录 wiki.gg 与 B站 Wiki（bwiki）两个站点
- **页面同步** — 单个/批量页面从 wiki.gg 同步到 bwiki
- **模块同步** — 批量同步 Module 命名空间页面
- **图片同步** — 同步页面引用的图片文件（支持单个/批量）
- **增量更新** — 每小时自动检测最近编辑并同步到镜像站
- **自动重连** — 登录过期自动检测并重新登录（3次重试机制）
- **登录重试** — 单次登录失败自动重试（最多3次，间隔5秒）

### 🔍 页面查询

- **精准匹配** — 标题/全拼/首字母精确匹配
- **拼音模糊匹配** — 支持中文名称的拼音搜索
- **QQ Markdown 按钮** — QQ群查询结果以可点击按钮形式呈现（点击即跳转页面）
- **命令别名** — `x` / `查wiki` 快捷命令

### 📋 模块同步 TodoList

- **自动同步** — 每周一 00:00 自动同步 wiki.gg 所有 Module 到待办
- **状态检查** — 每周二 00:00 自动检查模块同步状态（对比修订时间）
- **控制台管理** — 萌系风格可视化管理界面，支持搜索/筛选/分页
- **增删改查** — 完整的待办管理命令和控制台操作
- **权限控制** — 删除/清空操作需权限 2，删除缓存需权限 4

### � 路由重定向

- **短链接服务** — `/:id` → 跳转至完整 Wiki 页面 URL
- **GG 原站跳转** — `/gg/:id` → 跳转至 oxygennotincluded.wiki.gg 对应页面
- **Bwiki 镜像跳转** — `/bw/:id` → 跳转至 wiki.biligame.com/oni 对应页面
- **通配路径转发** — `/ggwiki/*` → 转发任意路径和查询参数到原站
- **持久化缓存** — 页面标题和页面ID映射保存在本地数据库，首次启动需执行 `update`

### 🎮 特殊指令

- **火箭计算器** — 查询 "火箭计算器" 返回计算器工具链接提示

## 📦 项目结构

```
oni-sync-bot/
├── src/
│   ├── index.ts                 # 插件入口（子插件注册表）
│   ├── services/
│   │   ├── wikiBotService.ts    # Wiki 机器人核心服务（登录、重连、代理）
│   │   └── consoleLogProvider.ts # 控制台日志服务
│   ├── plugins/
│   │   ├── databaseExtension.ts # 数据库模型扩展（wikipages 表）
│   │   ├── queryCommands.ts     # 页面查询命令（x / 查wiki）
│   │   ├── syncCommands.ts      # Wiki 同步命令（sync.*）+ 定时任务
│   │   ├── updateCommands.ts    # 缓存管理命令（update.* / redirect / relogin）
│   │   ├── routeRedirect.ts    # 路由重定向服务（/gg / /bw / /ggwiki）
│   │   └── todoList.ts          # TodoList 模块同步管理（命令 + 控制台 + 定时任务）
│   ├── sync/
│   │   ├── pageSync.ts          # 页面同步逻辑（单页、全量、增量）
│   │   ├── moduleSync.ts        # 模块同步逻辑
│   │   └── imgSync.ts           # 图片同步逻辑
│   └── utils/
│       └── tools.ts             # 工具函数（拼音生成、日志、错误处理）
├── client/
│   ├── Rocketcalculator/        # 火箭计算器前端页面
│   │   ├── calculator.ts
│   │   ├── calculator.vue
│   │   ├── config.ts
│   │   ├── index.vue
│   ├── onitodolist/             # TodoList 管理前端页面
│   │   ├── index.vue
│   │   └── todolist.vue
│   ├── index.ts
│   ├── page.vue                 # 日志查看页面
│   └── tsconfig.json
├── package.json
├── tsconfig.json
└── README.md
```

## 🔧 架构设计

### 子插件模式

主入口 `src/index.ts` 采用依赖顺序注册子插件：

```
Service 层（数据库、WikiBot 服务）
  ↓
Core 层（同步逻辑、路由重定向）
  ↓
Command 层（查询命令、同步命令、更新命令、TodoList）
  ↓
UI 层（控制台日志、TodoList 可视化面板、火箭计算器）
```

### 数据库模型

| 表名        | 字段                                                                                                                                                     | 说明                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `wikipages` | `id` (integer), `title` (string), `pinyin_full` (string), `pinyin_first` (string)                                                                        | Wiki 页面索引缓存，支持拼音检索 |
| `onitodos`  | `id` (unsigned, auto), `title` (string), `content` (text), `completed` (boolean), `createdBy` (string), `createdAt` (timestamp), `updatedAt` (timestamp) | 模块同步待办事项                |

### 核心技术

| 技术                         | 用途                                         |
| ---------------------------- | -------------------------------------------- |
| **TypeScript**               | 完整类型支持，严格模式编译                   |
| **Koishi 4**                 | 机器人框架，基于 Service 和 Plugin 架构      |
| **Mwn**                      | MediaWiki API 客户端（wiki.gg / bwiki 交互） |
| **pinyin-pro**               | 中文转拼音，支持页面名称模糊匹配             |
| **koishi-plugin-cron**       | 定时任务调度（每小时增量更新、每周同步等）   |
| **@koishijs/plugin-console** | Koishi 控制台（提供可视化管理界面）          |
| **@koishijs/plugin-server**  | HTTP 服务器（提供短链接重定向路由）          |

## ⚙️ 配置项

| 参数            | 说明                | 默认值                         | 必需 |
| --------------- | ------------------- | ------------------------------ | ---- |
| `ggUsername`    | WIKIGG 用户名       | `1`                            | ✅   |
| `ggPassword`    | WIKIGG 密码         | `1`                            | ✅   |
| `bwikiusername` | Bwiki 用户名        | `1`                            | ✅   |
| `bwikipassword` | Bwiki 密码          | `1`                            | ✅   |
| `domain`        | 你的短链域名        | `klei.vip`                     | ✅   |
| `main_site`     | 主站域名（wiki.gg） | `oxygennotincluded.wiki.gg/zh` | ✅   |
| `bwiki_site`    | 镜像站域名（bwiki） | `wiki.biligame.com/oni`        | ✅   |
| `logsUrl`       | 日志查看地址        | `https://klei.vip/onilogs`     | -    |

## 📚 命令列表

### 🔍 查询命令

| 命令            | 别名     | 说明                           | 权限 |
| --------------- | -------- | ------------------------------ | ---- |
| `x <itemName>`  | `查wiki` | 查询页面（标题/拼音/模糊匹配） | -    |
| `查询 <关键词>` | -        | 同上（备用命令名）             | -    |

### 🔄 同步命令

| 命令                     | 别名       | 说明                 | 权限 |
| ------------------------ | ---------- | -------------------- | ---- |
| `sync <标题>`            | -          | 同步单个页面到 bwiki | 2    |
| `sync.allpages`          | -          | 同步所有页面         | 2    |
| `sync.module <模块名>`   | -          | 同步单个模块         | 2    |
| `sync.allmodules`        | -          | 同步所有模块         | 2    |
| `sync.img <图片名>`      | -          | 同步单张图片         | 2    |
| `sync.allimgs`           | -          | 同步所有图片         | 2    |
| `sync.incrementalUpdate` | `增量更新` | 执行增量更新         | 2    |

### 📝 缓存管理

| 命令                           | 别名       | 说明                                | 权限 |
| ------------------------------ | ---------- | ----------------------------------- | ---- |
| `update`                       | -          | 更新本地页面缓存（从 wiki.gg 获取） | 2    |
| `update.status`                | -          | 查询缓存数量和状态                  | 1    |
| `update.delete`                | -          | 清空页面缓存                        | 4    |
| `redirect <原页面> <目标页面>` | `重定向`   | 在 wiki.gg 创建重定向页面           | 2    |
| `relogin`                      | `重新登录` | 手动重新登录两个 Wiki 机器人        | 2    |

### ✅ TodoList 命令

| 命令                   | 别名     | 说明                                     | 权限 |
| ---------------------- | -------- | ---------------------------------------- | ---- |
| `todolist`             | `todo`   | 查看 TodoList（跳转网页）                | -    |
| `todo.list`            | `todo.l` | 查看 TodoList（跳转网页）                | -    |
| `todo.add <标题>`      | `todo.a` | 添加待办事项（支持 `-c` `-u` 选项）      | -    |
| `todo.edit <id>`       | `todo.e` | 编辑待办事项（支持 `-t` `-c` `-u` 选项） | -    |
| `todo.complete <id>`   | `todo.c` | 标记待办为完成                           | -    |
| `todo.uncomplete <id>` | `todo.u` | 标记待办为未完成                         | -    |
| `todo.delete <id>`     | `todo.d` | 删除待办事项                             | 2    |
| `todo.clear`           | -        | 清空 TodoList                            | 2    |
| `todo.syncmodules`     | -        | 手动同步 wiki.gg 模块到 TodoList         | -    |
| `todo.checksync`       | -        | 手动检查模块同步状态                     | -    |

## ⏰ 定时任务

| 时间             | 任务                | 说明                                   |
| ---------------- | ------------------- | -------------------------------------- |
| **每小时 15 分** | 增量更新            | 获取最近编辑并同步到 bwiki             |
| **每周四 08:30** | 同步所有页面        | 从 wiki.gg 全量同步页面到 bwiki        |
| **每周三 08:30** | 同步所有图片        | 从 wiki.gg 全量同步图片资源            |
| **每周一 00:00** | 同步模块到 TodoList | 获取所有 Module 命名空间页面并写入待办 |
| **每周二 00:00** | 检查模块同步状态    | 对比修订时间，自动标记完成/未完成      |

## 🔌 路由接口

| 路径        | 方法 | 说明                                                      |
| ----------- | ---- | --------------------------------------------------------- |
| `/gg/:id`   | GET  | 跳转至 oxygennotincluded.wiki.gg 对应页面（自动编码标题） |
| `/bw/:id`   | GET  | 跳转至 wiki.biligame.com/oni 对应页面                     |
| `/ggwiki/*` | GET  | 通配路径转发至 oxygennotincluded.wiki.gg，保留查询参数    |

> � **提示**：首次部署请先执行 `update` 命令填充 `wikipages` 表，否则路由跳转将返回"未找到页面"提示。

## 🚀 安装

```bash
npm install koishi-plugin-oni-sync-bot
# 或
yarn add koishi-plugin-oni-sync-bot
```

## 🔨 开发

```bash
# 克隆项目
git clone https://github.com/Charles-LF/oni-sync-bot.git

# 安装依赖
yarn install

# 构建
yarn build

# 开发模式
yarn dev
```

### 依赖服务

插件正常运行需以下 Koishi 核心插件（Koishi 默认已提供）：

- **@koishijs/plugin-database** — 数据持久化（wikipages / onitodos）
- **@koishijs/plugin-server** — HTTP 服务器（短链接路由）
- **@koishijs/plugin-console** — 控制台 UI（TodoList 管理界面）
- **koishi-plugin-cron** — 定时任务调度
- **@koishijs/plugin-adapter-\*（可选）** — 如 QQ 适配器，以获得 Markdown 按钮效果

## 📊 使用示例

### 🔍 查询页面

```
> x 精炼器

🔍 为你找到【3】个相似结果，请点击下方按钮查看详情：

 1. [精炼器]
 2. [蒸汽精炼器]
 3. [岩浆精炼器]

（QQ 平台显示可点击按钮，点击即跳转 Wiki 页面；非 QQ 平台返回纯文本）
```

### 🔄 同步页面

```
> sync 精炼器

✅ 已尝试同步页面：精炼器，请前往控制台查看
```

### ✅ 标记待办完成

```
> todo.complete 5

✅ 已标记完成，请访问 https://klei.vip/onitodos 查看
```

## 🎨 控制台界面

插件在 Koishi 控制台提供以下管理页面：

| 页面                                 | 功能                                                 |
| ------------------------------------ | ---------------------------------------------------- |
| **日志控制台** (`page.vue`)          | 按级别筛选日志，搜索内容，自动滚动，快速跳转         |
| **TodoList 管理** (`onitodolist/`)   | 萌系 UI 设计，新增/编辑/标记完成，搜索筛选，分页显示 |
| **火箭计算器** (`Rocketcalculator/`) | ONI 火箭设计计算器                                   |

## 🔒 安全与权限

- 所有 Wiki 编辑操作（同步、创建重定向）需权限 **2**
- 删除页面缓存需权限 **4**
- 登录凭证（用户名/密码）仅保存在 Koishi 配置中，不会写入日志
- WikiBotService 通过 **Proxy** 模式透明处理登录过期，自动重新登录后继续执行原请求

## 🐛 故障排查

### "❌ 本地缓存为空"

请管理员执行 `update` 命令从 wiki.gg 获取页面列表。

### "❌ Wiki 机器人未就绪"

检查配置中的账号密码是否正确；可执行 `relogin` 手动重新登录。

### "❌ 未找到ID为【...】的页面"

页面ID不在本地缓存中，可能是最近新增的页面。执行 `update` 更新缓存后再试。

### QQ 机器人只显示纯文本

QQ 平台的 Markdown 与按钮效果需要 `session.platform === "qq"` 检测生效。请确认适配器正确上报平台信息。

## 📜 License

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📧 支持

如有问题，请在 GitHub 上提交 Issue，或访问 <https://klei.vip>。
