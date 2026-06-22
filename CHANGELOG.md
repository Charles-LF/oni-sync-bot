# Changelog

所有重要的项目更改将记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

### Added

- `src/plugins/routeRedirect.ts` 新增 `/ggwiki` 路由重定向，支持路径和查询参数透传

### Fixed

- `src/plugins/routeRedirect.ts` — 正则表达式不匹配空路径、单独斜杠和中文路径的问题，修改为使用 Unicode 属性转义 `\p{L}\p{N}` 支持多语言字符
- `src/plugins/routeRedirect.ts` — 路径遍历防护不完善，攻击者可通过 URL 编码（如 `%2e%2e`）绕过检测，修复为使用 `decodeURIComponent` 解码后再检查

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

[Unreleased]: https://github.com/Charles-lf/oni-sync-bot/compare/v0.8.9...HEAD
[0.8.9]: https://github.com/Charles-lf/oni-sync-bot/releases/tag/v0.8.9
[0.8.8]: https://github.com/Charles-lf/oni-sync-bot/releases/tag/v0.8.8
