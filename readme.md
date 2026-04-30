# koishi-plugin-oni-sync-bot

[![npm](https://img.shields.io/npm/v/koishi-plugin-oni-sync-bot?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-oni-sync-bot)
[![Koishi](https://img.shields.io/badge/koishi-plugin-42b983?style=flat-square)](https://koishi.chat)

缺氧 Wiki 站镜像点同步插件 - 自动同步两个缺氧 Wiki 站点的内容，同时提供 TodoList 管理功能。

## 功能特性

### 核心功能

- 🚀 **自动登录** - 支持 WIKIGG 和 bwiki 双站点登录
- 🔄 **自动重连** - 登录过期时自动重新登录并重试
- 📄 **页面同步** - 单个页面同步到目标站点
- 📦 **模块同步** - 批量同步指定前缀的页面
- 🖼️ **图片同步** - 同步页面引用的图片文件
- 🔍 **页面查询** - 查询页面历史版本和当前版本
- ⚡ **增量更新** - 定时检测并同步最近修改的内容

### TodoList 功能

- ✅ **待办事项管理** - 增删改查待办事项
- 📋 **控制台页面** - 可视化管理 TodoList
- 🔄 **模块同步** - 自动同步 wiki.gg 模块到 TodoList
- 📊 **同步状态检查** - 自动检查模块同步状态
- 🕐 **定时任务** - 每周一同步模块，每周二检查状态
- 🎨 **可爱风格** - 萌系风格的 UI 设计
- 🔍 **搜索筛选** - 支持关键词搜索和状态筛选
- 📄 **分页显示** - 支持分页和自定义每页条数
- 📱 **移动端适配** - 响应式设计，支持手机访问

## 安装

```bash
npm install koishi-plugin-oni-sync-bot
# 或
yarn add koishi-plugin-oni-sync-bot
```

## 配置

在 Koishi 控制台中配置以下参数：

| 参数            | 说明          | 默认值 |
| --------------- | ------------- | ------ |
| `ggUsername`    | WIKIGG 用户名 | 1      |
| `ggPassword`    | WIKIGG 密码   | 1      |
| `bwikiusername` | bwiki 用户名  | 1      |
| `bwikipassword` | bwiki 密码    | 1      |

## 命令列表

### 同步命令

| 命令                 | 说明                   |
| -------------------- | ---------------------- |
| `sync.page <标题>`   | 同步单个页面到 bwiki   |
| `sync.gg <标题>`     | 同步单个页面到 WIKIGG  |
| `sync.module <前缀>` | 同步指定前缀的所有页面 |
| `sync.img <标题>`    | 同步页面引用的图片     |
| `sync.update`        | 执行增量更新           |

### TodoList 命令

| 命令                   | 说明                                  | 权限要求 |
| ---------------------- | ------------------------------------- | -------- |
| `todo.list`            | 查看 TodoList（重定向到网页）        | -        |
| `todo.add <标题>`      | 添加待办事项                          | -        |
| `todo.edit <id>`       | 编辑待办事项                          | -        |
| `todo.complete <id>`   | 标记待办事项为完成                    | -        |
| `todo.uncomplete <id>` | 标记待办事项为未完成                  | -        |
| `todo.delete <id>`     | 删除待办事项                          | 2        |
| `todo.clear`           | 清空 TodoList                          | 2        |
| `todo.syncmodules`     | 同步 wiki.gg 模块到 TodoList          | -        |
| `todo.checksync`       | 检查模块同步状态                      | -        |

### 管理命令

| 命令      | 说明                   |
| --------- | ---------------------- |
| `relogin` | 手动重新登录两个机器人 |

## TodoList 命令示例

### 添加待办

```
/todo.add 同步模块 -c "同步 Module:Data" -u "管理员"
```

### 编辑待办

```
/todo.edit 1 -t "新标题" -c "新内容" -u "编辑者"
```

### 同步模块

```
/todo.syncmodules
```

### 检查同步状态

```
/todo.checksync
```

## 控制台功能

插件提供了两个可视化的控制台界面：

### 日志控制台

- 📋 **日志查看** - 按级别（全部/信息/警告/错误）筛选日志
- 🔍 **搜索功能** - 快速搜索日志内容
- ⏬ **自动滚动** - 新日志自动滚动到底部
- 🎯 **一键滚动** - 手动跳转到顶部或底部

### TodoList 控制台

- ✨ **可爱风格** - 萌系设计的 UI 界面
- ➕ **新增待办** - 弹窗表单添加待办
- ✏️ **编辑待办** - 修改待办内容和状态
- ✅ **完成标记** - 一键标记完成/未完成
- 🔍 **搜索筛选** - 支持按标题、内容搜索，按状态筛选
- 📄 **分页显示** - 超过 8 条自动分页，支持自定义每页条数
- 📊 **统计信息** - 显示总数、已完成、未完成数量
- 📱 **移动端适配** - 响应式布局，完美支持手机访问

**注意：控制台界面无法删除待办事项，删除操作仅可通过命令完成（需要权限 2）。**

## 定时任务

插件使用 `koishi-plugin-cron` 提供定时任务功能：

- **每周一 00:00** - 自动同步 wiki.gg 所有模块到 TodoList
- **每周二 00:00** - 自动检查模块同步状态，更新完成标记

## 技术特性

- ✅ **TypeScript** - 完整的类型支持
- 🎯 **面向对象** - 基于类的插件架构
- 🔌 **服务化设计** - 核心功能封装为独立服务
- 🧩 **模块化** - 功能拆分为独立子插件
- 🔄 **自动重试** - 登录失败自动重试（最多 3 次）
- 🔐 **自动重连** - 登录过期自动重新登录
- 🛡️ **错误处理** - 完善的错误处理和日志记录
- ⏱️ **API 限流** - 模块同步时请求间隔 1 秒
- 🔄 **API 重试** - API 调用失败自动重试（最多 3 次）
- 📦 **数据库持久化** - TodoList 数据存储在数据库中

## 项目结构

```
koishi-plugin-oni-sync-bot/
├── src/
│   ├── services/         # 服务层
│   │   ├── wikiBotService.ts    # Wiki 机器人服务
│   │   └── consoleLogProvider.ts # 日志控制台服务
│   ├── plugins/          # 插件层
│   │   ├── queryCommands.ts     # 查询命令插件
│   │   ├── syncCommands.ts      # 同步命令插件
│   │   ├── updateCommands.ts    # 更新命令插件
│   │   ├── todoList.ts          # TodoList 插件
│   │   ├── databaseExtension.ts  # 数据库扩展
│   │   └── routeRedirect.ts     # 路由重定向
│   ├── sync/             # 同步逻辑
│   │   ├── pageSync.ts          # 页面同步
│   │   ├── moduleSync.ts        # 模块同步
│   │   └── imgSync.ts           # 图片同步
│   ├── utils/            # 工具函数
│   │   └── tools.ts             # 通用工具
│   ├── client/           # 前端
│   │   ├── page.vue             # 日志页面
│   │   ├── onitodolist/         # TodoList 页面
│   │   │   └── todolist.vue     # TodoList 主组件
│   │   └── index.ts             # 入口
│   └── index.ts          # 主入口
├── package.json
└── tsconfig.json
```

## TodoList 模块同步逻辑

### 模块同步流程

1. 从 wiki.gg 获取命名空间 828（Module）的所有页面
2. 逐个获取每个模块的最新修订信息（用户、时间、注释）
3. 将模块信息存入 TodoList：
   - `title` = 模块名称
   - `content` = 修订注释
   - `createdBy` = 修订用户
   - `createdAt` / `updatedAt` = 修订时间
   - `completed` = false（默认未完成）

### 同步状态检查

1. 获取所有 TodoList 中的待办事项
2. 对每个待办：
   - 从 wiki.gg 获取最新修订时间
   - 从 bwikia 获取最新修订时间
   - 对比时间：
     - 如果 bwikia 时间 ≥ wiki.gg 时间 → 标记为已完成
     - 如果 bwikia 时间 < wiki.gg 时间 → 标记为未完成

## 开发

```bash
# 创建 KOISHI 项目
yarn create koishi

# 克隆项目
git clone https://github.com/Charles-LF/oni-sync-bot.git

# 安装依赖
yarn install

# 构建
yarn build

# 开发模式
yarn dev
```

## License

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request！

## 支持

如有问题，请在 GitHub 上提交 Issue。
