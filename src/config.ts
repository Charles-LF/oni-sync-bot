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
 * 渲染文本抽取相关配置。
 *
 * @deprecated 0.12.0 起 `.ai` 改为「mwn 实时抓取 + cheerio 清洗」，不再落库、不再做全量预热，
 * 本组配置已**不再被读取**。保留 schema 只是为了旧 `koishi.yml` / 旧控制台配置不报错。
 */
export interface WikiTextConfig {
  /** @deprecated 渲染文本不再随页面同步写入数据库 */
  textSyncOnChange: boolean;
  /** @deprecated api.php 地址由 mwn 客户端内置 */
  textApiUrl?: string;
  /** @deprecated 清洗策略已固定在代码里（保留信息框） */
  textTableMode: "flatten" | "drop";
  /** @deprecated 正文长度由 `fetchPagePlainText` 的 limit 控制 */
  textMaxLength: number;
  /** @deprecated 不再批量抓取 */
  textSyncInterval: number;
}

export const WikiTextConfig: Schema<WikiTextConfig> = Schema.object({
  textSyncOnChange: Schema.boolean()
    .description("⚠️ 已废弃（0.12 起不再使用）：渲染文本不再随页面同步写入数据库")
    .default(false),
  textApiUrl: Schema.string()
    .description("⚠️ 已废弃（0.12 起不再使用）：api.php 地址由 mwn 客户端内置")
    .default(""),
  textTableMode: Schema.union([
    Schema.const("flatten").description(
      "信息框抽成「标签：值」，正文表格压平成「单元格 | 单元格」（保留耗电/产热/材料等数值）",
    ),
    Schema.const("drop").description(
      "丢弃全部表格（信息框里的关键数值也会一并丢失）",
    ),
  ])
    .description("⚠️ 已废弃（0.12 起不再使用）：清洗策略已固定为保留信息框")
    .default("flatten"),
  textMaxLength: Schema.natural()
    .description("⚠️ 已废弃（0.12 起不再使用）：AI 取正文时固定截断 3000 字")
    .default(20000),
  textSyncInterval: Schema.natural()
    .description("⚠️ 已废弃（0.12 起不再使用）：不再批量抓取渲染文本")
    .default(300),
});

/**
 * 旧的本地向量检索配置。
 *
 * @deprecated 0.12.0 起 `.ai` 改为 Function Calling + mwn 实时抓取，vectra 与
 * transformers.js 已从依赖中移除。键位**全部保留**，避免旧配置在控制台报「未知字段」，
 * 但代码里不再读取任何一项。
 */
export interface VectorConfig {
  /** @deprecated 向量检索已移除 */
  vectorEnabled: boolean;
  /** @deprecated 向量检索已移除 */
  vectorIndexPath: string;
  /** @deprecated 向量检索已移除 */
  embeddingModel: string;
  /** @deprecated 向量检索已移除 */
  embeddingDtype: "fp32" | "q8" | "fp16" | "q4";
  /** @deprecated 向量检索已移除 */
  embeddingCacheDir: string;
  /** @deprecated 向量检索已移除 */
  embeddingRemoteHost: string;
  /** @deprecated 向量检索已移除 */
  chunkSize: number;
  /** @deprecated 向量检索已移除 */
  chunkOverlap: number;
  /** @deprecated 向量检索已移除 */
  maxChunksPerPage: number;
  /** @deprecated 向量检索已移除 */
  retrieveTopK: number;
  /** @deprecated 向量检索已移除 */
  retrieveMinScore: number;
  /** @deprecated 向量检索已移除 */
  queryInstruction: string;
  /** @deprecated 向量检索已移除 */
  embedBatchSize: number;
}

export const VectorConfig: Schema<VectorConfig> = Schema.object({
  vectorEnabled: Schema.boolean()
    .description("⚠️ 已废弃（0.12 起不再使用）：检索已改为 Function Calling")
    .default(false),
  vectorIndexPath: Schema.string()
    .description("⚠️ 已废弃（0.12 起不再使用）：不再生成向量索引")
    .default("data/oni-vector"),
  embeddingModel: Schema.string()
    .description("⚠️ 已废弃（0.12 起不再使用）：不再本地推理")
    .default("Xenova/bge-small-zh-v1.5"),
  embeddingDtype: Schema.union([
    Schema.const("q8").description("8bit 量化"),
    Schema.const("fp32").description("全精度"),
    Schema.const("fp16").description("半精度"),
    Schema.const("q4").description("4bit 量化"),
  ])
    .description("⚠️ 已废弃（0.12 起不再使用）")
    .default("q8"),
  embeddingCacheDir: Schema.string()
    .description("⚠️ 已废弃（0.12 起不再使用）：不再下载模型，可删除该目录")
    .default("data/oni-models"),
  embeddingRemoteHost: Schema.string()
    .description("⚠️ 已废弃（0.12 起不再使用）")
    .default("https://hf-mirror.com"),
  chunkSize: Schema.natural()
    .description("⚠️ 已废弃（0.12 起不再使用）")
    .default(350)
    .min(80),
  chunkOverlap: Schema.natural()
    .description("⚠️ 已废弃（0.12 起不再使用）")
    .default(60),
  maxChunksPerPage: Schema.natural()
    .description("⚠️ 已废弃（0.12 起不再使用）")
    .default(16)
    .min(1),
  retrieveTopK: Schema.natural()
    .description("⚠️ 已废弃（0.12 起不再使用）")
    .default(5)
    .min(1),
  retrieveMinScore: Schema.number()
    .description("⚠️ 已废弃（0.12 起不再使用）")
    .default(0.2)
    .min(0)
    .max(1),
  queryInstruction: Schema.string()
    .description("⚠️ 已废弃（0.12 起不再使用）")
    .default("为这个句子生成表示以用于检索相关文章："),
  embedBatchSize: Schema.natural()
    .description("⚠️ 已废弃（0.12 起不再使用）")
    .default(4)
    .min(1),
});

/** DeepSeek 问答 */
export interface AiConfig {
  aiEnabled: boolean;
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  aiTemperature: number;
  aiMaxTokens: number;
  aiTimeout: number;
  aiCooldown: number;
  aiMaxQuestionLength: number;
  aiMemoryTurns: number;
  aiMemoryTtl: number;
  aiChannelMemory: boolean;
}

export const AiConfig: Schema<AiConfig> = Schema.object({
  aiEnabled: Schema.boolean().description("启用 .ai 问答命令").default(true),
  deepseekApiKey: Schema.string()
    .description("DeepSeek API Key（也可用环境变量 DEEPSEEK_API_KEY）")
    .role("secret")
    .default(""),
  deepseekBaseUrl: Schema.string()
    .description("DeepSeek API 地址")
    .default("https://api.deepseek.com"),
  deepseekModel: Schema.string()
    .description("使用的模型")
    .default("deepseek-chat"),
  aiTemperature: Schema.number()
    .description("采样温度，越低越保守（防幻觉建议 0~0.3）")
    .default(0.2)
    .min(0)
    .max(2),
  aiMaxTokens: Schema.natural()
    .description("回答的最大 token 数")
    .default(700),
  aiTimeout: Schema.natural()
    .description("调用 DeepSeek 的超时时间（毫秒）")
    .default(60000),
  aiCooldown: Schema.natural()
    .description("同一用户连续提问的冷却时间（秒）")
    .default(5),
  aiMaxQuestionLength: Schema.natural()
    .description("问题最大长度（字符），超出直接拒绝")
    .default(200),
  aiMemoryTurns: Schema.natural()
    .description("短期记忆保留的问答轮数（0 表示不记忆；建议 2~3）")
    .default(2)
    .max(5),
  aiMemoryTtl: Schema.natural()
    .description("短期记忆的过期时间（秒），超过则视为新话题")
    .default(600),
  aiChannelMemory: Schema.boolean()
    .description(
      "允许群内承接话题：用户自己没提问记录时，用群里上一条问答的语境回答「那它…」这类追问",
    )
    .default(true),
});

/**
 * 插件完整配置 = 各分组之并集。
 * 顺序即控制台中的展示顺序，也保持与重构前首次出现顺序一致。
 */
export interface Config
  extends AccountConfig,
    SiteConfig,
    NotifyConfig,
    ScheduleConfig,
    WikiTextConfig,
    VectorConfig,
    AiConfig {}

export const Config: Schema<Config> = Schema.intersect([
  AccountConfig,
  SiteConfig,
  NotifyConfig,
  ScheduleConfig,
  WikiTextConfig,
  VectorConfig,
  AiConfig,
] as const);
