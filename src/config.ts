import { Schema } from "koishi";

/**
 * 插件配置的**唯一声明处**。
 *
 * 约束：每个配置键只允许在这里出现一次。
 *
 * 早期实现让每个子插件各自声明一份 `Config`，再在 `index.ts` 里用
 * `Schema.intersect` 拼接。结果是同一个键被重复声明：
 * `domain` 3 次、`main_site` / `bwiki_site` / `logsUrl` 各 2 次、
 * 4 个账号字段各 2 次。`intersect` 合并重复键时后者覆盖前者，
 * 控制台里会出现同一字段多份且语义略有出入。
 *
 * 新增子插件时：**不要**新建重复字段，把需要的字段归到语义合适的分组里，
 * 子插件通过 `Pick` / `extends` 引用分组即可。
 */

/** 短链域名与两个站点地址 */
export interface SiteConfig {
  domain: string;
  main_site: string;
  bwiki_site: string;
}

export const SiteConfig: Schema<SiteConfig> = Schema.object({
  domain: Schema.string()
    .description("你的短链域名（必填，如：klei.vip）")
    .default("klei.vip"),
  main_site: Schema.string()
    .description("主站域名（必填，如：oxygennotincluded.wiki.gg）")
    .default("oxygennotincluded.wiki.gg/zh"),
  bwiki_site: Schema.string()
    .description("镜像站域名（必填，如：wiki.biligame.com）")
    .default("wiki.biligame.com/oni"),
});

/** WIKIGG 与 bwiki 的机器人账号 */
export interface AccountConfig {
  ggUsername: string;
  ggPassword: string;
  bwikiusername: string;
  bwikipassword: string;
}

export const AccountConfig: Schema<AccountConfig> = Schema.object({
  ggUsername: Schema.string().description("WIKIGG 用户名").default("1"),
  ggPassword: Schema.string().description("WIKIGG 密码").default("1"),
  bwikiusername: Schema.string().description("bwiki用户名").default("1"),
  bwikipassword: Schema.string().description("bwiki密码").default("1"),
});

/** 日志地址与同步结果通知 */
export interface NotifyConfig {
  logsUrl: string;
  notifyGroupIds?: string[];
  notifyBotPlatform?: string;
}

export const NotifyConfig: Schema<NotifyConfig> = Schema.object({
  logsUrl: Schema.string()
    .description("日志查看地址")
    .default("https://klei.vip/onilogs"),
  notifyGroupIds: Schema.array(Schema.string())
    .description(
      '增量更新同步成功时通知的群频道ID列表，如 ["group:123456"]，留空则不发送通知',
    )
    .default([]),
  notifyBotPlatform: Schema.string()
    .description("通知 bot 的平台标识，默认 qq")
    .default("qq"),
});

/** 定时任务 */
export interface ScheduleConfig {
  updateCron?: string;
}

export const ScheduleConfig: Schema<ScheduleConfig> = Schema.object({
  updateCron: Schema.string()
    .description("页面缓存自动更新 cron 表达式（默认每天凌晨 2 点）")
    .default("0 2 * * *"),
});

/**
 * 插件完整配置 = 各分组之并集。
 * 顺序即控制台中的展示顺序，也保持与重构前首次出现顺序一致。
 */
export interface Config
  extends AccountConfig, SiteConfig, NotifyConfig, ScheduleConfig {}

export const Config: Schema<Config> = Schema.intersect([
  AccountConfig,
  SiteConfig,
  NotifyConfig,
  ScheduleConfig,
] as const);
