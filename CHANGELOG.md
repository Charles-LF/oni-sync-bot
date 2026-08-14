# Changelog

所有重要的项目更改将记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

### Added

### Changed

### Fixed

- `src/plugins/queryCommands.ts` 修复模糊匹配算法：新增公共前缀匹配评分，解决相近词条无法返回到待选列表的问题

### Removed

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

[Unreleased]: https://github.com/Charles-lf/oni-sync-bot/compare/v0.9.2...HEAD
[0.9.2]: https://github.com/Charles-lf/oni-sync-bot/releases/tag/v0.9.2
[0.9.1]: https://github.com/Charles-lf/oni-sync-bot/releases/tag/v0.9.1
[0.8.9]: https://github.com/Charles-lf/oni-sync-bot/releases/tag/v0.8.9
[0.8.8]: https://github.com/Charles-lf/oni-sync-bot/releases/tag/v0.8.8
