import { Context, Session } from "koishi";
import type { SiteConfig } from "../config";
import { generatePinyinInfo } from "../utils/tools";
import { findFuzzyMatches, type MatchResult } from "../utils/matcher";
import { MessageRenderer } from "../services/messageRenderer";
import { WikiPages } from "./databaseExtension";

/** 只用到共享站点配置里的 domain */
export type QueryCommandsConfig = Pick<SiteConfig, "domain">;

/** 需要特殊回复的关键词（命中后直接返回预设文案） */
const SPECIAL_CASES = new Map([
  [
    "火箭计算器",
    "请前往以下站点使用火箭计算器工具：\n\nhttps://klei.vip/calculator\n\n（注：该工具正在测试阶段，数据可能不够准确，仅供参考）",
  ],
]);

/** `x` / `查wiki` 命令：精准匹配 + 拼音模糊匹配 + 序号选择 */
export class QueryCommands {
  public static readonly inject = ["database"];
  public config: QueryCommandsConfig;
  private ctx: Context;
  private renderer: MessageRenderer;

  constructor(ctx: Context, config: QueryCommandsConfig) {
    this.ctx = ctx;
    this.config = config;
    this.renderer = new MessageRenderer(ctx, config.domain);
    this.registerCommands(ctx);
  }

  private registerCommands(ctx: Context) {
    ctx
      .command("x <itemName:text>", "查询缺氧中文wiki，精准匹配+拼音模糊匹配")
      .alias("/查wiki")
      .action(async ({ session }, itemName = "") => {
        const queryKey = itemName.trim().toLowerCase();

        if (!queryKey) {
          return this.renderer.usageMessage(session);
        }

        const specialCase = SPECIAL_CASES.get(queryKey);
        if (specialCase !== undefined) {
          return this.renderer.send(session, specialCase);
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
          return this.renderer.resultMessage(
            session,
            preciseMatch,
            preciseMatch.prefix,
          );
        }

        const allPages = await ctx.database.get("wikipages", {});
        if (allPages.length === 0) {
          return this.renderer.send(
            session,
            "❌ 本地缓存为空，请联系管理员执行【update】指令更新缓存！",
          );
        }

        const fuzzyMatches = findFuzzyMatches(
          allPages,
          queryKey,
          queryPinyinFull,
          queryPinyinFirst,
        );
        if (fuzzyMatches.length === 0) {
          return this.renderer.send(
            session,
            `❌ 未找到【${queryKey}】相关内容，请按游戏内标准名称重新查询！`,
          );
        }

        return await this.handleSelection(session, fuzzyMatches);
      });
  }

  /** 标题 / 全拼 / 首字母三种精准匹配，命中即返回（带用于展示的前缀文案） */
  private async findPreciseMatch(
    ctx: Context,
    queryKey: string,
    queryPinyinFull: string,
    queryPinyinFirst: string,
  ): Promise<(WikiPages & { prefix?: string }) | null> {
    const checks: Array<{ query: Record<string, string>; prefix?: string }> = [
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

  /**
   * 处理多候选选择：
   * - QQ：直接回按钮列表，结束；
   * - 其它平台：提示输入序号并等待 15 秒。
   */
  private async handleSelection(
    session: Session | undefined,
    matches: MatchResult[],
  ): Promise<string | undefined> {
    const resultCount = matches.length;

    if (this.renderer.isQQ(session)) {
      let markdown = `**🔍 为你找到【 ${resultCount} 】个相似结果，请点击下方按钮查看详情：**\n`;
      matches.forEach((item, index) => {
        markdown += `\n> \`${index + 1}\`. **${item.title}**\n`;
      });
      return this.renderer.send(
        session,
        markdown,
        this.renderer.matchListKeyboard(matches),
      );
    }

    let replyMsg = `🔍 未找到精准匹配，为你找到【 ${resultCount} 】个相似结果，请输入序号选择（10秒内有效）：\n`;
    matches.forEach((item, index) => {
      replyMsg += `${index + 1}. ${item.title}\n`;
    });
    replyMsg += `\n❗️ 提示：超时将静默结束，无任何回应`;

    await this.renderer.send(session, replyMsg);

    const userInput = await session?.prompt(15000);
    if (!userInput) return;

    const selectNum = parseInt(userInput.trim(), 10);
    if (isNaN(selectNum) || selectNum < 1 || selectNum > resultCount) {
      return this.renderer.send(
        session,
        `❌ 输入无效！请输入 1-${resultCount} 之间的数字序号`,
      );
    }

    const selected = matches[selectNum - 1];
    return this.renderer.resultMessage(session, selected, "✅ 选择成功");
  }
}
