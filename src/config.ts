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
 * 渲染文本抽取（BWiki `action=parse` 的结果 → 纯文本 → 入库）。
 *
 * 只保存**渲染后的正文**，Wikitext 源码仍然只用于同步，不进入 AI 检索链路。
 */
export interface WikiTextConfig {
  textSyncOnChange: boolean;
  textApiUrl?: string;
  textTableMode: "flatten" | "drop";
  textMaxLength: number;
  textSyncInterval: number;
}

export const WikiTextConfig: Schema<WikiTextConfig> = Schema.object({
  textSyncOnChange: Schema.boolean()
    .description("页面同步成功后，自动抓取 BWiki 渲染文本并写入向量库")
    .default(true),
  textApiUrl: Schema.string()
    .description(
      "BWiki 的 api.php 地址；留空则由 bwiki_site 自动拼接为 https://<bwiki_site>/api.php",
    )
    .default(""),
  textTableMode: Schema.union([
    Schema.const("flatten").description(
      "信息框抽成「标签：值」，正文表格压平成「单元格 | 单元格」（保留耗电/产热/材料等数值）",
    ),
    Schema.const("drop").description(
      "丢弃全部表格（信息框里的关键数值也会一并丢失）",
    ),
  ])
    .description("正文表格处理方式")
    .default("flatten"),
  textMaxLength: Schema.natural()
    .description("单页最多保留的纯文本字数（超出截断，防止超长页面撑爆内存）")
    .default(20000),
  textSyncInterval: Schema.natural()
    .description("批量抓取渲染文本时，每个页面之间的间隔（毫秒）")
    .default(300),
});

/** 本地向量检索（vectra 索引文件 + transformers.js 本地 Embedding 模型） */
export interface VectorConfig {
  vectorEnabled: boolean;
  vectorIndexPath: string;
  embeddingModel: string;
  embeddingDtype: "fp32" | "q8" | "fp16" | "q4";
  embeddingCacheDir: string;
  embeddingRemoteHost: string;
  chunkSize: number;
  chunkOverlap: number;
  maxChunksPerPage: number;
  retrieveTopK: number;
  retrieveMinScore: number;
  queryInstruction: string;
  embedBatchSize: number;
}

export const VectorConfig: Schema<VectorConfig> = Schema.object({
  vectorEnabled: Schema.boolean()
    .description("启用本地向量库（关闭后 .ai 退化为标题匹配的降级检索）")
    .default(true),
  vectorIndexPath: Schema.string()
    .description("vectra 索引目录（相对 Koishi 工作目录）")
    .default("data/oni-vector"),
  embeddingModel: Schema.string()
    .description("本地 Embedding 模型（transformers.js 的模型名或本地目录）")
    .default("Xenova/bge-small-zh-v1.5"),
  embeddingDtype: Schema.union([
    Schema.const("q8").description("8bit 量化，最小最快（推荐 2G 内存服务器）"),
    Schema.const("fp32").description("全精度，最准但更占内存"),
    Schema.const("fp16").description("半精度"),
    Schema.const("q4").description("4bit 量化，最小但精度略降"),
  ])
    .description("Embedding 模型精度")
    .default("q8"),
  embeddingCacheDir: Schema.string()
    .description("模型缓存目录（首次运行会自动下载模型）")
    .default("data/oni-models"),
  embeddingRemoteHost: Schema.string()
    .description(
      "模型下载源；默认使用 hf-mirror 镜像，留空则用官方 huggingface.co",
    )
    .default("https://hf-mirror.com"),
  chunkSize: Schema.natural()
    .description("单块文本的目标字数")
    .default(350)
    .min(80),
  chunkOverlap: Schema.natural()
    .description("相邻文本块的重叠字数")
    .default(60),
  maxChunksPerPage: Schema.natural()
    .description(
      "单页最多切分的块数（直接决定索引体积与内存占用，2G 机器建议 12~16）",
    )
    .default(16)
    .min(1),
  retrieveTopK: Schema.natural()
    .description(
      "检索时送入模型的文本块数量（信息框这类「单点数值」通常排在第 4~5，建议 5）",
    )
    .default(5)
    .min(1),
  retrieveMinScore: Schema.number()
    .description("检索结果的最低余弦相似度，低于该值视为无关")
    .default(0.2)
    .min(0)
    .max(1),
  queryInstruction: Schema.string()
    .description("BGE 系列模型的查询指令前缀，用于提升检索命中率")
    .default("为这个句子生成表示以用于检索相关文章："),
  embedBatchSize: Schema.natural()
    .description("单次送入 Embedding 模型的文本条数（内存紧张时调小）")
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
