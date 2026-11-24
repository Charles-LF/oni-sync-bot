import { Schema } from "koishi";

/**
 * 插件配置的唯一声明处：**每个键只允许出现一次**。
 * 新增子插件时把字段归到语义相符的分组，再用 `Pick` / `extends` 引用，
 * 不要重复声明（重复会在控制台出现多份同名字段）。
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

/** 同步结果群通知 */
export interface NotifyConfig {
  notifyGroupIds?: string[];
  notifyBotPlatform?: string;
}

export const NotifyConfig: Schema<NotifyConfig> = Schema.object({
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

/** 增量同步（变更检测） */
export interface DeltaSyncConfig {
  syncCron: string;
  syncLogLimit: number;
  syncCheckImages: boolean;
  syncMaxPagesPerRun: number;
  syncMaxImagesPerRun: number;
  syncOverlapSeconds: number;
  syncFallbackHours: number;
  syncTaskLogLimit: number;
  syncRunKeep: number;
}

export const DeltaSyncConfig: Schema<DeltaSyncConfig> = Schema.object({
  syncCron: Schema.string()
    .description("增量同步 cron 表达式（默认每小时第 15 分）")
    .default("15 * * * *"),
  syncLogLimit: Schema.natural()
    .description("最近更改记录的保留条数（控制台列表上限）")
    .default(5000)
    .min(200)
    .max(50000),
  syncCheckImages: Schema.boolean()
    .description("增量同步时一并比对图片（关闭则只同步页面）")
    .default(true),
  syncMaxPagesPerRun: Schema.natural()
    .description("单轮最多同步的页面数，超出部分留到下一轮")
    .default(300)
    .min(1)
    .max(5000),
  syncMaxImagesPerRun: Schema.natural()
    .description("单轮最多同步的图片数")
    .default(100)
    .min(1)
    .max(2000),
  syncOverlapSeconds: Schema.natural()
    .description("拉取起始时间向前偏移的秒数，抵消 MediaWiki 写入延迟（默认 10）")
    .default(10)
    .max(300),
  syncFallbackHours: Schema.natural()
    .description(
      "首次运行（还没有水位）时向前回溯的小时数；更早的变更需要「全量同步页面」补齐",
    )
    .default(24)
    .min(1)
    .max(720),
  syncTaskLogLimit: Schema.natural()
    .description(
      "任务详情里每次运行保留的日志条数，超出按时间清理最早的记录",
    )
    .default(500)
    .min(100)
    .max(5000),
  syncRunKeep: Schema.natural()
    .description("任务详情保留最近多少次运行（含其条目与日志）")
    .default(20)
    .min(5)
    .max(200),
});

/** 完整配置 = 各分组之并集，顺序即控制台展示顺序 */
export interface Config
  extends AccountConfig,
    SiteConfig,
    NotifyConfig,
    ScheduleConfig,
    DeltaSyncConfig {}

export const Config: Schema<Config> = Schema.intersect([
  AccountConfig,
  SiteConfig,
  NotifyConfig,
  ScheduleConfig,
  DeltaSyncConfig,
] as const);
