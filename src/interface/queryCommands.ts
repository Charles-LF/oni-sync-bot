import { Context, Session } from "koishi";
import type { SiteConfig } from "../config";
import { generatePinyinInfo } from "../utils/tools";
import { findFuzzyMatches, type MatchResult } from "../utils/matcher";
import { MessageRenderer } from "./messageRenderer";
import { WikiPages } from "../infrastructure/persistence/databaseExtension";

/** 只用到共享站点配置里的 domain */
export type QueryCommandsConfig = Pick<SiteConfig, "domain">;

/**
 * 需要特殊回复的关键词（命中后直接返回预设文案）。
 *
 * 文案里的域名取自配置，别写死 `klei.vip` —— 换了 `domain` 之后链接要跟着变。
 */
const SPECIAL_CASES = new Map<string, (domain: string) => string>([
  [
    "火箭计算器",
    (domain) =>
      `请前往以下站点使用火箭计算器工具：\n\nhttps://${domain}/calculator\n\n（注：该工具正在测试阶段，数据可能不够准确，仅供参考）`,
  ],
]);

/** 页面列表缓存时长：`wikipages` 只在 `update` 时变，几秒内重复查询不必反复读全表 */
const PAGE_CACHE_TTL = 60_000;

/** 非 QQ 平台等待序号的时间（毫秒）；提示文案按它生成，避免文案与实现不一致 */
const SELECTION_TIMEOUT = 15_000;

/** 一次精准匹配的结果：要么直接命中一页，要么给出多个候选 */
interface PreciseLookup {
  page?: WikiPages & { prefix?: string };
  candidates?: MatchResult[];
}

/** `x` / `查wiki` 命令：精准匹配 + 拼音模糊匹配 + 序号选择 */
export class QueryCommands {
  public static readonly inject = ["database"];
  public config: QueryCommandsConfig;
  private renderer: MessageRenderer;
  /** 全表缓存（含 in-flight 的 Promise，避免并发查询时重复读库） */
  private pageCache?: { at: number; task: Promise<WikiPages[]> };

  constructor(ctx: Context, config: QueryCommandsConfig) {
    this.config = config;
    this.renderer = new MessageRenderer(ctx, config.domain);
    this.registerCommands(ctx);
  }

  private registerCommands(ctx: Context) {
    ctx
      .command("x <itemName:text>", "查询缺氧中文wiki，精准匹配+拼音模糊匹配")
      .alias("/查wiki")
      .action(async ({ session }, itemName = "") => {
        // 标题按原样比（英文标题大小写敏感），拼音与特殊词条用小写
        const rawKey = itemName.trim();
        const queryKey = rawKey.toLowerCase();

        if (!rawKey) {
          return this.renderer.usageMessage(session);
        }

        const specialCase = SPECIAL_CASES.get(queryKey);
        if (specialCase) {
          return this.renderer.send(session, specialCase(this.config.domain));
        }

        const { pinyin_full: queryPinyinFull, pinyin_first: queryPinyinFirst } =
          generatePinyinInfo(queryKey);

        const precise = await this.findPreciseMatch(ctx, rawKey, queryKey);
        if (precise.page) {
          return this.renderer.resultMessage(
            session,
            precise.page,
            precise.page.prefix,
          );
        }
        if (precise.candidates) {
          // 拼音命中多页（如 jidi → 极地 / 基地）：交给用户选，不再随便挑第一个
          return this.handleSelection(ctx, session, precise.candidates);
        }

        const allPages = await this.loadPages(ctx);
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
            `❌ 未找到【${rawKey}】相关内容，请按游戏内标准名称重新查询！\n` +
              `（若确认该页面存在，可能还没同步，请管理员执行 update 更新缓存）`,
          );
        }

        return await this.handleSelection(ctx, session, fuzzyMatches);
      });
  }

  /** 读页面列表（60 秒内的重复查询直接命中缓存） */
  private async loadPages(ctx: Context): Promise<WikiPages[]> {
    const now = Date.now();
    if (this.pageCache && now - this.pageCache.at < PAGE_CACHE_TTL) {
      return this.pageCache.task;
    }

    const task = ctx.database.get("wikipages", {});
    this.pageCache = { at: now, task };
    try {
      return await task;
    } catch (error) {
      // 读失败不留坏缓存，下次重新读
      this.pageCache = undefined;
      throw error;
    }
  }

  /**
   * 精准匹配，按优先级逐级尝试：
   * 标题（原样） → 全拼 → 首字母 → 标题（忽略大小写）。
   *
   * 拼音命中多页时返回**候选列表**而不是第一个结果：`pinyin_full` 的重码很常见
   * （`jidi` 既是「极地」也是「基地」），随便取一个等于随机答案。
   */
  private async findPreciseMatch(
    ctx: Context,
    rawKey: string,
    queryKey: string,
  ): Promise<PreciseLookup> {
    const byTitle = await ctx.database.get("wikipages", { title: rawKey });
    if (byTitle.length > 0) {
      return { page: { ...byTitle[0], prefix: "✅ 精准匹配成功" } };
    }

    const pinyinChecks: Array<{
      field: "pinyin_full" | "pinyin_first";
      makePrefix: (title: string) => string;
    }> = [
      {
        field: "pinyin_full",
        makePrefix: (title) => `✅ 拼音精准匹配成功（${rawKey} → ${title}）`,
      },
      {
        field: "pinyin_first",
        makePrefix: (title) => `✅ 首字母精准匹配成功（${rawKey} → ${title}）`,
      },
    ];

    for (const check of pinyinChecks) {
      const rows = await ctx.database.get("wikipages", {
        [check.field]: queryKey,
      });
      if (rows.length === 0) continue;

      const sorted = [...rows].sort((a, b) => a.title.localeCompare(b.title));
      if (sorted.length === 1) {
        return {
          page: { ...sorted[0], prefix: check.makePrefix(sorted[0].title) },
        };
      }
      return {
        candidates: sorted.map((row) => ({
          id: row.id,
          title: row.title,
          score: 0,
        })),
      };
    }

    // 拼音都没中时，再忽略大小写找一次标题（`sandbox` → `Sandbox`）。
    // 列表走缓存，fuzzy 阶段本来也要读，不额外付出一次全表查询。
    const pages = await this.loadPages(ctx);
    const hit = pages.find((page) => page.title.toLowerCase() === queryKey);
    if (hit) return { page: { ...hit, prefix: "✅ 精准匹配成功" } };

    return {};
  }

  /**
   * 处理多候选选择：
   * - QQ：直接回按钮列表，结束；
   * - 其它平台：提示输入序号，只等**提问者本人**的回复。
   */
  private async handleSelection(
    ctx: Context,
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

    const seconds = Math.round(SELECTION_TIMEOUT / 1000);
    let replyMsg = `🔍 未找到精准匹配，为你找到【 ${resultCount} 】个相似结果，请输入序号选择（${seconds} 秒内有效）：\n`;
    matches.forEach((item, index) => {
      replyMsg += `${index + 1}. ${item.title}\n`;
    });
    replyMsg += `\n❗️ 提示：超时将静默结束，无任何回应`;

    await this.renderer.send(session, replyMsg);
    if (!session) return;

    const userInput = await this.waitForUserInput(ctx, session, SELECTION_TIMEOUT);
    if (userInput === undefined) return;

    // 只认纯数字：`3abc` / `3.5` 都不该被 parseInt 悄悄当成 3
    const text = userInput.trim();
    const selectNum = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isInteger(selectNum) || selectNum < 1 || selectNum > resultCount) {
      return this.renderer.send(
        session,
        `❌ 输入无效！请输入 1-${resultCount} 之间的数字序号`,
      );
    }

    const selected = matches[selectNum - 1];
    return this.renderer.resultMessage(session, selected, "✅ 选择成功");
  }

  /**
   * 等提问者本人在同一频道的下一条消息。
   *
   * 不用 `session.prompt()`：它会把**频道里任何人的**下一条消息当成答案，
   * 群友随手发一句就会被吞掉。这里只拦同一用户的回复，其余消息原样放行。
   */
  private waitForUserInput(
    ctx: Context,
    session: Session,
    timeout: number,
  ): Promise<string | undefined> {
    const self = session;
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let dispose: () => void = () => {};

      const finish = (value?: string) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        dispose();
        resolve(value);
      };

      dispose = ctx.middleware((next, next2) => {
        const fromSelf =
          next.userId === self.userId && next.channelId === self.channelId;
        if (!fromSelf) return next2();
        finish((next.content ?? "").trim());
        // 返回非空值 = 吃掉这条消息，不再往下传
        return undefined;
      });

      timer = setTimeout(() => finish(undefined), timeout);
    });
  }
}
