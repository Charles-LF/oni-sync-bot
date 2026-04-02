import { Context } from "koishi";

declare module "koishi" {
  interface Tables {
    wikipages: WikiPages;
  }
}

export interface WikiPages {
  id: number;
  title: string;
  pinyin_full: string;
  pinyin_first: string;
}

export class DatabaseExtension {
  public static readonly inject = ["database"];

  constructor(ctx: Context) {
    ctx.model.extend("wikipages", {
      id: "integer",
      title: "string",
      pinyin_full: "string",
      pinyin_first: "string",
    });
  }
}

export function apply(ctx: Context) {
  ctx.plugin(DatabaseExtension);
}
