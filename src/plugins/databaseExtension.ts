import { Context } from "koishi";

declare module "koishi" {
  interface Tables {
    wikipages: WikiPages;
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
 * `.ai` 的短期记忆落库表。
 *
 * 记忆本身很轻（每轮约 1KB），但**不能只放内存**：Koishi 一重启（部署、HMR、崩溃重启）
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
