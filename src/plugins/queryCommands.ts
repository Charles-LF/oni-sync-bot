import { Context, Schema } from "koishi";
import { generatePinyinInfo } from "../utils/tools";
import { WikiPages } from "./databaseExtension";

export interface QueryCommandsConfig {
  domain: string;
}

interface MatchResult {
  id: number;
  title: string;
  score: number;
}

const SPECIAL_CASES = new Map([
  [
    "火箭计算器",
    "请前往以下站点使用火箭计算器工具：\n\nhttps://klei.vip/calculator\n\n（注：该工具正在测试阶段，数据可能不够准确，仅供参考）",
  ],
]);

export class QueryCommands {
  public static readonly inject = ["database"];
  public config: QueryCommandsConfig;

  constructor(ctx: Context, config: QueryCommandsConfig) {
    this.config = config;
    this.registerCommands(ctx);
  }

  private registerCommands(ctx: Context) {
    ctx
      .command("x <itemName>", "查询缺氧中文wiki，精准匹配+拼音模糊匹配")
      .alias("/查wiki")
      .action(async ({ session }, itemName = "") => {
        const queryKey = itemName.trim().toLowerCase();

        if (!queryKey) {
          return this.getUsageMessage();
        }

        if (SPECIAL_CASES.has(queryKey)) {
          return SPECIAL_CASES.get(queryKey);
        }

        const { pinyin_full: queryPinyinFull, pinyin_first: queryPinyinFirst } =
          generatePinyinInfo(queryKey);

        const preciseMatch = await this.findPreciseMatch(
          ctx,
          queryKey,
          queryPinyinFull,
          queryPinyinFirst,
        );
        if (preciseMatch) {
          return this.formatResultMessage(
            preciseMatch,
            (preciseMatch as any).prefix,
          );
        }

        const allPages = await ctx.database.get("wikipages", {});
        if (allPages.length === 0) {
          return `❌ 本地缓存为空，请联系管理员执行【update】指令更新缓存！`;
        }

        const fuzzyMatches = this.findFuzzyMatches(
          allPages as WikiPages[],
          queryKey,
          queryPinyinFull,
          queryPinyinFirst,
        );
        if (fuzzyMatches.length === 0) {
          return `❌ 未找到【${queryKey}】相关内容，请按游戏内标准名称重新查询！`;
        }

        return await this.handleSelection(session, fuzzyMatches);
      });
  }

  private getUsageMessage(): string {
    return `以下是使用说明：\n原站点: https://${this.config.domain}/gg/88888888\n\nbwiki: https://${this.config.domain}/bw/88888888`;
  }

  private formatResultMessage(match: WikiPages, prefix?: string): string {
    let message = "";
    if (prefix) {
      message += prefix + "\n";
    }
    message += `原站点: https://${this.config.domain}/gg/${match.id}\n\nbwiki: https://${this.config.domain}/bw/${match.id}`;
    return message;
  }

  private async findPreciseMatch(
    ctx: Context,
    queryKey: string,
    queryPinyinFull: string,
    queryPinyinFirst: string,
  ): Promise<(WikiPages & { prefix?: string }) | null> {
    const checks: Array<{ query: any; prefix?: string }> = [
      { query: { title: queryKey }, prefix: "✅ 精准匹配成功" },
      {
        query: { pinyin_full: queryKey },
        prefix: `✅ 拼音精准匹配成功（${queryKey} → `,
      },
      {
        query: { pinyin_first: queryKey },
        prefix: `✅ 首字母精准匹配成功（${queryKey} → `,
      },
    ];

    for (const check of checks) {
      const results = await ctx.database.get("wikipages", check.query);
      if (results.length > 0) {
        const match = results[0] as WikiPages & { prefix?: string };
        let prefix = check.prefix;
        if (prefix && prefix.includes("→")) {
          prefix += `${match.title}）`;
        }
        match.prefix = prefix;
        return match;
      }
    }

    return null;
  }

  private calculateScore(
    page: WikiPages,
    queryKey: string,
    queryPinyinFull: string,
    queryPinyinFirst: string,
  ): number {
    let score = 0;
    const { title, pinyin_full, pinyin_first } = page;

    if (title.includes(queryKey)) score += 10;
    if (pinyin_full.startsWith(queryPinyinFull)) score += 9;
    if (pinyin_full.includes(queryPinyinFull)) score += 8;
    if (pinyin_first.includes(queryPinyinFirst)) score += 6;
    if (
      queryPinyinFull.includes(
        pinyin_full.substring(
          0,
          Math.min(pinyin_full.length, queryPinyinFull.length),
        ),
      )
    ) {
      score += 5;
    }

    return score;
  }

  private findFuzzyMatches(
    allPages: WikiPages[],
    queryKey: string,
    queryPinyinFull: string,
    queryPinyinFirst: string,
  ): MatchResult[] {
    const matchResults: MatchResult[] = [];

    for (const page of allPages) {
      const score = this.calculateScore(
        page,
        queryKey,
        queryPinyinFull,
        queryPinyinFirst,
      );
      if (score > 0) {
        matchResults.push({ id: page.id, title: page.title, score });
      }
    }

    return matchResults
      .sort((a, b) => b.score - a.score || a.title.length - b.title.length)
      .filter(
        (item, index, array) =>
          array.findIndex((t) => t.title === item.title) === index,
      )
      .slice(0, 5);
  }

  private async handleSelection(
    session: any,
    matches: MatchResult[],
  ): Promise<string> {
    const resultCount = matches.length;

    let replyMsg = `🔍 未找到精准匹配，为你找到【 ${resultCount} 】个相似结果，请输入序号选择（10秒内有效）：\n`;
    matches.forEach((item, index) => {
      replyMsg += `${index + 1}. ${item.title}\n`;
    });
    replyMsg += `\n❗️ 提示：超时将静默结束，无任何回应`;
    await session.send(replyMsg);

    const userInput = await session.prompt(15000);
    if (!userInput) return;

    const selectNum = parseInt(userInput.trim(), 10);
    if (isNaN(selectNum) || selectNum < 1 || selectNum > resultCount) {
      return `❌ 输入无效！请输入 1-${resultCount} 之间的数字序号`;
    }

    const selected = matches[selectNum - 1];
    return this.formatResultMessage(
      selected as unknown as WikiPages,
      "✅ 选择成功",
    );
  }
}

export namespace QueryCommands {
  export const Config: Schema<QueryCommandsConfig> = Schema.object({
    domain: Schema.string()
      .description("你的短链域名（必填，如：klei.vip）")
      .default("klei.vip"),
  });
}

export function apply(ctx: Context, config: QueryCommandsConfig) {
  ctx.plugin(QueryCommands, config);
}
