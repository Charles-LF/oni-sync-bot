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
  private ctx: Context;

  constructor(ctx: Context, config: QueryCommandsConfig) {
    this.ctx = ctx;
    this.config = config;
    this.registerCommands(ctx);
  }

  private registerCommands(ctx: Context) {
    ctx
      .command("x <itemName:text>", "查询缺氧中文wiki，精准匹配+拼音模糊匹配")
      .alias("/查wiki")
      .action(async ({ session }, itemName = "") => {
        const queryKey = itemName.trim().toLowerCase();

        if (!queryKey) {
          return this.renderUsageMessage(session);
        }

        if (SPECIAL_CASES.has(queryKey)) {
          const content = SPECIAL_CASES.get(queryKey);
          return this.sendResponse(session, content);
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
          return this.renderResultMessage(
            session,
            preciseMatch,
            (preciseMatch as any).prefix,
          );
        }

        const allPages = await ctx.database.get("wikipages", {});
        if (allPages.length === 0) {
          return this.sendResponse(
            session,
            "❌ 本地缓存为空，请联系管理员执行【update】指令更新缓存！",
          );
        }

        const fuzzyMatches = this.findFuzzyMatches(
          allPages,
          queryKey,
          queryPinyinFull,
          queryPinyinFirst,
        );
        if (fuzzyMatches.length === 0) {
          return this.sendResponse(
            session,
            `❌ 未找到【${queryKey}】相关内容，请按游戏内标准名称重新查询！`,
          );
        }

        return await this.handleSelection(session, fuzzyMatches);
      });
  }

  private isQQPlatform(session: any): boolean {
    return session?.platform === "qq";
  }

  private buildLinkButton(idSuffix: string, label: string, url: string): any {
    return {
      id: `btn-${idSuffix}`,
      render_data: {
        label,
        visited_label: "已打开",
        style: 1,
      },
      action: {
        type: 0,
        permission: {
          type: 2,
        },
        data: url,
      },
    };
  }

  private buildQQKeyboard(matches: MatchResult[]): any {
    const rows: any[] = [];
    for (let i = 0; i < matches.length; i += 2) {
      const buttonsInRow = matches.slice(i, i + 2).map((item) => {
        const label =
          item.title.length > 10 ? item.title.slice(0, 10) : item.title;
        return this.buildLinkButton(
          `${item.id}`,
          label,
          `https://${this.config.domain}/bw/${item.id}`,
        );
      });
      rows.push({ buttons: buttonsInRow });
    }
    return {
      content: { rows },
    };
  }

  private async sendResponse(session: any, content: string, keyboard?: any) {
    if (this.isQQPlatform(session)) {
      try {
        const payload: any = {
          msg_id: session.messageId,
          msg_type: 2,
          markdown: {
            content,
          },
        };
        if (keyboard) {
          payload.keyboard = keyboard;
        }
        await session.bot.internal.sendMessage(session.channelId, payload);
        return;
      } catch (e) {
        this.ctx
          .logger("oni-sync-bot")
          .warn("QQ Markdown 发送失败，降级为纯文本:", e);
        return content;
      }
    }
    return content;
  }

  private renderUsageMessage(session: any) {
    if (this.isQQPlatform(session)) {
      const md =
        "**以下是使用说明：**\n" +
        `> GG原站点: [https://${this.config.domain}/gg/88888888](https://${this.config.domain}/gg/88888888)\n` +
        `\n> bwiki: [https://${this.config.domain}/bw/88888888](https://${this.config.domain}/bw/88888888)\n`;
      return this.sendResponse(session, md);
    }
    return (
      `以下是使用说明：\nGG原站点: https://${this.config.domain}/gg/88888888\n` +
      `\nbwiki: https://${this.config.domain}/bw/88888888`
    );
  }

  private buildResultKeyboard(match: WikiPages): any {
    return {
      content: {
        rows: [
          {
            buttons: [
              this.buildLinkButton(
                `gg-${match.id}`,
                "GG 原站",
                `https://${this.config.domain}/gg/${match.id}`,
              ),
            ],
          },
          {
            buttons: [
              this.buildLinkButton(
                `bw-${match.id}`,
                "Bwiki 镜像",
                `https://${this.config.domain}/bw/${match.id}`,
              ),
            ],
          },
          {
            buttons: [
              this.buildLinkButton(
                `wiki-${match.id}`,
                "GG直链",
                `https://oxygennotincluded.wiki.gg/zh/${encodeURIComponent(match.title)}`,
              ),
            ],
          },
        ],
      },
    };
  }

  private renderResultMessage(session: any, match: WikiPages, prefix?: string) {
    if (this.isQQPlatform(session)) {
      let md = "";
      if (prefix) {
        md += `**${prefix}**\n`;
      }
      md += `**📖 ${match.title}**\n`;
      const keyboard = this.buildResultKeyboard(match);
      return this.sendResponse(session, md, keyboard);
    }
    let message = "";
    if (prefix) {
      message += prefix + "\n";
    }
    message += `GG原站点: https://${this.config.domain}/gg/${match.id}\n\nbwiki: https://${this.config.domain}/bw/${match.id}`;
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
  ): Promise<any> {
    const resultCount = matches.length;

    let replyMsg: string;

    if (this.isQQPlatform(session)) {
      let md = `**🔍 为你找到【 ${resultCount} 】个相似结果，请点击下方按钮查看详情：**\n`;
      matches.forEach((item, index) => {
        md += `\n> \`${index + 1}\`. **${item.title}**\n`;
      });
      const keyboard = this.buildQQKeyboard(matches);
      await this.sendResponse(session, md, keyboard);
      return;
    }

    replyMsg = `🔍 未找到精准匹配，为你找到【 ${resultCount} 】个相似结果，请输入序号选择（10秒内有效）：\n`;
    matches.forEach((item, index) => {
      replyMsg += `${index + 1}. ${item.title}\n`;
    });
    replyMsg += `\n❗️ 提示：超时将静默结束，无任何回应`;

    await this.sendResponse(session, replyMsg);

    const userInput = await session.prompt(15000);
    if (!userInput) return;

    const selectNum = parseInt(userInput.trim(), 10);
    if (isNaN(selectNum) || selectNum < 1 || selectNum > resultCount) {
      return this.sendResponse(
        session,
        `❌ 输入无效！请输入 1-${resultCount} 之间的数字序号`,
      );
    }

    const selected = matches[selectNum - 1];
    return this.renderResultMessage(
      session,
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
