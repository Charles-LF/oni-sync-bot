# koishi-plugin-oni-sync-bot

[![npm](https://img.shields.io/npm/v/koishi-plugin-oni-sync-bot?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-oni-sync-bot)
[![Koishi](https://img.shields.io/badge/koishi-plugin-42b983?style=flat-square)](https://koishi.chat)

缺氧 Wiki 站镜像点同步插件 - 自动同步两个缺氧 Wiki 站点的内容。

## 功能特性

- 🚀 **自动登录** - 支持 WIKIGG 和 bwiki 双站点登录
- 🔄 **自动重连** - 登录过期时自动重新登录并重试
- 📄 **页面同步** - 单个页面同步到目标站点
- 📦 **模块同步** - 批量同步指定前缀的页面
- 🖼️ **图片同步** - 同步页面引用的图片文件
- 🔍 **页面查询** - 查询页面历史版本和当前版本
- 📊 **日志控制台** - 可视化日志查看和管理
- ⚡ **增量更新** - 定时检测并同步最近修改的内容

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

### 管理命令

| 命令      | 说明                   |
| --------- | ---------------------- |
| `relogin` | 手动重新登录两个机器人 |

## 使用示例

### 同步单个页面

```
/sync.page 缺氧
```

### 同步模块

```
/sync.module 缺氧:
```

### 同步图片

```
/sync.img 电解器.png
```

### 手动重新登录

```
/relogin
```

## 控制台功能

插件提供了可视化的控制台界面：

- 📋 **日志查看** - 按级别（全部/信息/警告/错误）筛选日志
- 🔍 **搜索功能** - 快速搜索日志内容
- ⏬ **自动滚动** - 新日志自动滚动到底部
- 🎯 **一键滚动** - 手动跳转到顶部或底部

## 技术特性

- ✅ **TypeScript** - 完整的类型支持
- 🎯 **面向对象** - 基于类的插件架构
- 🔌 **服务化设计** - 核心功能封装为独立服务
- 🧩 **模块化** - 功能拆分为独立子插件
- 🔄 **自动重试** - 登录失败自动重试
- 🔐 **自动重连** - 登录过期自动重新登录

## 项目结构

```
koishi-plugin-oni-sync-bot/
├── src/
│   ├── services/         # 服务层
│   │   └── wikiBotService.ts    # Wiki 机器人服务
│   ├── plugins/          # 插件层
│   │   ├── command.ts           # 基础命令插件
│   │   ├── queryCommands.ts     # 查询命令插件
│   │   ├── syncCommands.ts      # 同步命令插件
│   │   ├── updateCommands.ts    # 更新命令插件
│   │   └── consoleLogProvider.ts # 日志控制台插件
│   ├── sync/             # 同步逻辑
│   │   ├── pageSync.ts          # 页面同步
│   │   ├── moduleSync.ts        # 模块同步
│   │   └── imgSync.ts           # 图片同步
│   ├── utils/            # 工具函数
│   │   └── tools.ts             # 通用工具
│   ├── config/           # 配置
│   │   └── index.ts             # 配置定义
│   ├── client/           # 前端
│   │   ├── page.vue             # 日志页面
│   │   └── index.ts             # 入口
│   └── index.ts          # 主入口
├── package.json
└── tsconfig.json
```

## 开发

```bash
# 创建KOISHI项目
yarn create koishi

# 克隆项目
git clone <https://github.com/Charles-LF/oni-sync-bot.git>

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
