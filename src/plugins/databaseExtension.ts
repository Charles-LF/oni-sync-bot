import { Context } from "koishi";

declare module "koishi" {
  interface Tables {
    wikipages: WikiPages;
    wikitexts: WikiTexts;
    oniaimemory: OniAiMemory;
  }
}

export interface WikiPages {
  id: number;
  title: string;
  pinyin_full: string;
  pinyin_first: string;
  contributor?: string;
  change_time?: string;
}

/**
 * BWiki 渲染后的纯文本（AI 检索的唯一数据来源）。
 *
 * 主键用**页面标题**而不是自增 id：标题与 `wikipages.title` 天然对齐，
 * `upsert` 可以直接按标题覆盖，不需要额外查询。
 */
export interface WikiTexts {
  /** 主键：页面标题 */
  id: string;
  title: string;
  pageid?: number;
  revid?: number;
  /** 正文的 sha1，用于跳过未变化的页面（避免重复 Embedding） */
  hash: string;
  text: string;
  updated_at: string;
}

/**
 * `.ai` 的短期记忆落库表。
 *
 * 记忆本身很轻（每轮约 2KB），但**不能只放内存**：Koishi 一重启（部署、HMR、崩溃重启）
 * 群里的追问上下文就断了，用户会看到「刚问过电解器，接着问耗电多少却说未提及」。
 */
export interface OniAiMemory {
  /** 主键：`平台:频道:用户` 或 `topic:平台:频道` */
  id: string;
  /** JSON 序列化的 MemoryTurn[] */
  payload: string;
  /** 最近一次写入的毫秒时间戳，用于过期清理 */
  updated_at: number;
}

export class DatabaseExtension {
  public static readonly inject = ["database"];

  constructor(ctx: Context) {
    ctx.model.extend("wikipages", {
      id: "integer",
      title: "string",
      pinyin_full: "string",
      pinyin_first: "string",
      contributor: "string",
      change_time: "string",
    });

    ctx.model.extend(
      "wikitexts",
      {
        id: "string",
        title: "string",
        pageid: "integer",
        revid: "integer",
        hash: "string",
        text: "text",
        updated_at: "string",
      },
      { primary: "id" },
    );

    ctx.model.extend(
      "oniaimemory",
      {
        id: "string",
        payload: "text",
        updated_at: "integer",
      },
      { primary: "id" },
    );
  }
}
