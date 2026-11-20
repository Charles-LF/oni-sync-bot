import { Context, Logger, Session } from "koishi";
import type { AiConfig, SiteConfig } from "../config";
import {
  AGENT_SYSTEM_PROMPT,
  ANSWER_SYSTEM_PROMPT,
  AiService,
  NO_ANSWER_TEXT,
  isNoAnswer,
  type AgentMessage,
  type ParsedToolCall,
  type ToolDefinition,
} from "../services/aiService";
import { AiMemory, pickContext, type MemoryTurn } from "../services/aiMemory";
import { MessageRenderer } from "../services/messageRenderer";
import { generatePinyinInfo, getErrorMessage, siteUrl } from "../utils/tools";
import { findFuzzyMatches } from "../utils/matcher";

/** 只用到共享站点配置里的 domain 与 bwiki_site */
export type AiQueryConfig = AiConfig &
  Pick<SiteConfig, "domain" | "bwiki_site">;

/** 工具名：AI 通过它要求程序去 BWiki 取正文 */
export const SEARCH_TOOL_NAME = "search_oni_bwiki";

/** 单次问答最多真正执行几个检索（比较类问题通常 2 个，再多就是模型发散） */
const MAX_TOOL_CALLS = 2;

/**
 * 本地拼音模糊匹配的最低分：6 分只代表「首字母包含」，
 * 一个乱码关键词也可能凑上，宁可交给 wiki 全文检索。
 */
const MIN_FUZZY_SCORE = 8;

/** 交给 DeepSeek 的工具声明 */
const SEARCH_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: SEARCH_TOOL_NAME,
    description:
      "检索缺氧中文 BWIKI 的页面正文（模板与模块已展开，包含信息框里的耗电、产热、尺寸、材料等数值）。询问任何游戏内容前必须先调用本工具。",
    parameters: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description:
            "要检索的缺氧词条名，优先使用游戏内标准中文名，如「电解器」「氧石精炼炉」",
        },
      },
      required: ["keyword"],
    },
  },
};

/** 回答里展示的来源 */
interface AiSource {
  title: string;
  url: string;
}

/** 一次 Agent 问答的结果 */
interface AgentAnswer {
  answer: string;
  sources: AiSource[];
  /** 本轮实际查过的页面标题（写入记忆，供下一轮兜底） */
  pages: string[];
}

/**
 * `.ai` 问答：DeepSeek Function Calling + mwn 实时抓取 BWiki 正文。
 *
 * 数据链路（Wikitext 源码永远不参与 AI）：
 * `用户问题` → DeepSeek 发起 `search_oni_bwiki(keyword)` → 本地 `wikipages` 拼音匹配出标题
 * → `wikiBot.fetchPagePlainText(title)`（mwn `action=parse` + cheerio 清洗）
 * → `role:'tool'` 回填正文 → DeepSeek 生成回答。
 *
 * 为什么单独做成子插件：`QueryCommands` 只依赖数据库、回复页面链接；
 * AI 问答额外依赖 http + wikiBot + 外部 API，单独成插件后任何一环没配好，
 * 都不会影响原有的 `x` 拼音查询。
 */
export class AiQueryCommands {
  /** `wikiBot` / `http` 可选：缺任意一项时 `.ai` 仍应给出明确提示，而不是整组命令消失 */
  public static readonly inject = {
    database: { required: true },
    wikiBot: { required: false },
    http: { required: false },
  };

  private readonly config: AiQueryConfig;
  private readonly renderer: MessageRenderer;
  private readonly ai: AiService;
  private readonly log: Logger;
  private readonly pageUrlBase: string;
  /** 用户 → 上次提问时间，用于冷却 */
  private readonly lastAskedAt = new Map<string, number>();
  /** 用户 → 最近几轮问答，用于追问 */
  private readonly memory: AiMemory;
  /** 频道 → 最近一轮问答，用于「群里别人刚问过，我接着问」 */
  private readonly channelMemory: AiMemory;

  constructor(
    private readonly ctx: Context,
    config: AiQueryConfig,
  ) {
    this.config = config;
    this.renderer = new MessageRenderer(ctx, config.domain);
    this.ai = new AiService(ctx, config);
    this.log = ctx.logger("oni-ai");

    const bwiki = siteUrl(config.bwiki_site || "wiki.biligame.com/oni");
    this.pageUrlBase = `${bwiki}/`;
    this.memory = new AiMemory(config.aiMemoryTurns, config.aiMemoryTtl * 1000);
    // 群内话题只承接「上一轮」，且与用户记忆同 TTL，避免不同人的话题互相串
    this.channelMemory = new AiMemory(
      Math.min(1, Math.max(0, config.aiMemoryTurns)),
      config.aiMemoryTtl * 1000,
    );

    this.registerCommands(ctx);
  }

  private registerCommands(ctx: Context) {
    ctx
      .command("ai <question:text>", "基于缺氧 BWIKI 资料的 AI 问答")
      .alias("/问缺氧")
      .alias("问缺氧")
      .action(async ({ session }, question = "") => {
        const keyword = question.trim();

        if (!keyword) {
          return this.renderer.send(
            session,
            "📖 用法：ai <你的问题>\n例如：ai 电解器耗电多少？\n（回答仅依据 BWIKI 资料，数据来源：缺氧 BWIKI）",
          );
        }

        if (keyword.length > this.config.aiMaxQuestionLength) {
          return this.renderer.send(
            session,
            `❌ 问题太长了，请精简到 ${this.config.aiMaxQuestionLength} 字以内`,
          );
        }

        if (!this.ctx.http) {
          return this.renderer.send(
            session,
            "❌ 未启用 http 服务（@koishijs/plugin-http），无法调用 AI 接口",
          );
        }

        if (!this.ai.enabled) {
          return this.renderer.send(
            session,
            "❌ AI 问答未启用：请在插件配置里填写 deepseekApiKey，或设置环境变量 DEEPSEEK_API_KEY",
          );
        }

        const waitSeconds = this.cooldownLeft(session);
        if (waitSeconds > 0) {
          return this.renderer.send(
            session,
            `⏳ 提问太频繁了，请 ${waitSeconds} 秒后再试`,
          );
        }

        const context = await this.resolveContext(session);

        try {
          const result = await this.runAgent(keyword, context.turns);
          this.remember(session, keyword, result.answer, result.pages);
          return this.renderAnswer(
            session,
            result.answer,
            result.sources,
            context.inheritedFrom,
          );
        } catch (error) {
          this.log.error(`[ai] 「${keyword}」回答失败：${getErrorMessage(error)}`);
          return this.renderer.send(
            session,
            "❌ AI 服务暂时不可用，请稍后再试（管理员可查看日志）",
          );
        }
      });

    ctx
      .command("ai.status", "查看 AI 问答状态", { authority: 1 })
      .action(async () => {
        const rows = await ctx.database.get("wikipages", {}, ["id"]);
        const ready = Boolean(this.ctx.wikiBot?.isBWikiBotReady());

        const lines = [
          "📊 AI 问答状态",
          `├─ AI 问答：${this.ai.enabled ? "✅ 已启用" : "❌ 未配置 API Key"}`,
          `├─ 模型：${this.config.deepseekModel}`,
          `├─ 检索方式：Function Calling（${SEARCH_TOOL_NAME}）`,
          `├─ BWiki 客户端：${ready ? "✅ 已登录" : "❌ 未就绪（先执行 relogin）"}`,
          `├─ 本地页面缓存：${rows.length} 个（缺失页面由 mwn 实时抓取）`,
          `├─ 会话记忆：${
            this.config.aiMemoryTurns > 0
              ? `${this.config.aiMemoryTurns} 轮 / ${Math.round(this.config.aiMemoryTtl / 60)} 分钟`
              : "已关闭"
          }`,
          `└─ 群内追问：${
            this.config.aiChannelMemory && this.config.aiMemoryTurns > 0
              ? "✅ 开启"
              : "❌ 关闭"
          }`,
        ];
        return lines.join("\n");
      });
  }

  // -------------------------------------------------------------- Agent 主流程

  /**
   * 一次完整的 Agent 问答：正常情况两轮模型调用（模型不肯调工具时三轮）。
   *
   * 1. 第 1 轮带 `tools` 与 `tool_choice:'auto'`，让模型自己决定检索什么；
   * 2. 模型没有发起调用时，用 `tool_choice:'required'` **强制**检索一次
   *    （防止它凭记忆作答）；这一步失败也不影响出答案，会退回第 1 轮的内容；
   * 3. 每个 `tool_call` 都必须回填一条 `role:'tool'`，否则下一次请求不合法；
   * 4. 第 2 轮带 `tools` 但 `tool_choice:'none'`：既保证消息结构对各家兼容层都合法，
   *    又明确禁止再次调工具，把回答收敛到一次检索内。
   */
  private async runAgent(
    question: string,
    turns: MemoryTurn[],
  ): Promise<AgentAnswer> {
    const history: AgentMessage[] = [];
    for (const turn of turns) {
      if (!turn.question || !turn.answer) continue;
      history.push({ role: "user", content: turn.question });
      history.push({ role: "assistant", content: turn.answer });
    }

    const messages: AgentMessage[] = [
      { role: "system", content: AGENT_SYSTEM_PROMPT },
      ...history,
      { role: "user", content: question },
    ];

    let decision = await this.ai.complete(messages, {
      tools: [SEARCH_TOOL],
      toolChoice: "auto",
    });

    if (decision.toolCalls.length === 0) {
      this.log.info(`[ai] 模型未调用工具，改为强制检索：${question}`);
      messages.push(decision.message);
      try {
        decision = await this.ai.complete(messages, {
          tools: [SEARCH_TOOL],
          toolChoice: "required",
        });
      } catch (error) {
        // 个别兼容层不支持 tool_choice='required'：不让它把整次问答拖垮
        this.log.warn(
          `[ai] 强制检索调用失败，回退为直接回答：${getErrorMessage(error)}`,
        );
      }
    }

    if (decision.toolCalls.length === 0) {
      this.log.warn(
        `[ai] 「${question}」没有产生检索调用，直接采用模型回答（可能不含资料支撑）`,
      );
      const answer = decision.content || NO_ANSWER_TEXT;
      return { answer, sources: [], pages: [] };
    }

    const toolMessages: AgentMessage[] = [];
    const sources: AiSource[] = [];
    const pages: string[] = [];

    for (let index = 0; index < decision.toolCalls.length; index++) {
      const call = decision.toolCalls[index];
      if (index >= MAX_TOOL_CALLS) {
        toolMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `（单次最多检索 ${MAX_TOOL_CALLS} 个词条，本条已跳过）`,
        });
        continue;
      }

      const keyword = readKeyword(call);
      if (!keyword) {
        toolMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: "（未提供 keyword，本次未检索）",
        });
        continue;
      }

      const page = await this.searchPage(keyword, turns);
      if (!page) {
        toolMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `未找到与「${keyword}」相关的 BWIKI 页面。`,
        });
        continue;
      }

      if (!pages.includes(page.title)) {
        pages.push(page.title);
        sources.push({ title: page.title, url: this.pageUrl(page.title) });
      }
      toolMessages.push({
        role: "tool",
        tool_call_id: call.id,
        content: `页面：${page.title}\n链接：${this.pageUrl(page.title)}\n---\n${page.text}`,
      });
    }

    const finalMessages: AgentMessage[] = [
      { role: "system", content: ANSWER_SYSTEM_PROMPT },
      ...history,
      { role: "user", content: question },
      decision.message,
      ...toolMessages,
    ];

    // 带 tools + tool_choice:'none'：结构对所有兼容层都合法，同时禁止再调工具
    const final = await this.ai.complete(finalMessages, {
      tools: [SEARCH_TOOL],
      toolChoice: "none",
    });
    const answer = final.content || NO_ANSWER_TEXT;
    this.log.info(
      `[ai] 「${question}」→ 检索 ${pages.join("、") || "（无）"}，回答 ${answer.length} 字`,
    );
    return { answer, sources, pages };
  }

  /**
   * 按关键词取页面正文。
   *
   * 先解析出一串候选标题（本地拼音匹配 → wiki 全文检索 → 原样用关键词），
   * 逐个尝试抓取，第一个拿到正文的即为结果。
   */
  private async searchPage(
    keyword: string,
    turns: MemoryTurn[],
  ): Promise<{ title: string; text: string } | null> {
    const wikiBot = this.ctx.wikiBot;
    if (!wikiBot) {
      this.log.warn("[ai] 未启用 wikiBot 服务，无法获取 BWiki 正文");
      return null;
    }

    const titles = await this.resolveTitles(keyword);
    for (const title of titles) {
      const text = await wikiBot.fetchPagePlainText(title);
      if (text) {
        this.log.info(`[ai] Agent 决定检索: ${title}（关键词「${keyword}」）`);
        return { title, text };
      }
    }

    // 追问兜底：关键词没解析出页面时，沿用上一轮查过的那一页
    const previous = turns[turns.length - 1]?.page;
    if (previous && !titles.includes(previous)) {
      const text = await wikiBot.fetchPagePlainText(previous);
      if (text) {
        this.log.info(`[ai] 检索未命中，沿用上一轮页面: ${previous}`);
        return { title: previous, text };
      }
    }

    this.log.info(`[ai] Agent 决定检索: 未找到「${keyword}」对应页面`);
    return null;
  }

  /**
   * 关键词 → 候选页面标题。
   *
   * 与 `x` 查询同源的三级解析：
   * 1. `wikipages` 精确标题；
   * 2. `wikipages` 拼音 / 首字母 / 前缀模糊匹配（分数门槛 8，纯首字母命中不可信）；
   * 3. BWiki 全文检索（救「高压制氧」这类不是页面名的叫法）；
   * 4. 最后把关键词原样当标题（`redirects:true` 能吃掉重定向）。
   */
  private async resolveTitles(keyword: string): Promise<string[]> {
    const kw = keyword.trim();
    if (!kw) return [];

    const titles: string[] = [];
    const push = (title?: string) => {
      const value = title?.trim();
      if (value && !titles.includes(value)) titles.push(value);
    };

    // 模型偶尔给出「电解器 耗电」这种带问句成分的关键词：拆出能当标题的部分
    const segments = kw
      .split(/[\s，,、。？?！!：:；;“”"'（）()]+/)
      .map((part) => part.trim())
      .filter(Boolean);

    try {
      const pages = await this.ctx.database.get("wikipages", {});
      if (pages.length > 0) {
        for (const candidate of [kw, ...segments]) {
          push(pages.find((page) => page.title === candidate)?.title);
        }

        for (const candidate of [kw, ...segments]) {
          const { pinyin_full, pinyin_first } = generatePinyinInfo(candidate);
          const matches = findFuzzyMatches(
            pages,
            candidate.toLowerCase(),
            pinyin_full,
            pinyin_first,
            3,
          );
          const best = matches.find(
            (match) => match.score >= MIN_FUZZY_SCORE,
          );
          if (best) push(best.title);
        }
      }
    } catch (error) {
      this.log.debug(`[ai] 读取页面缓存失败：${getErrorMessage(error)}`);
    }

    for (const candidate of [kw, ...segments]) {
      const searched = (await this.ctx.wikiBot?.searchPageTitles(candidate, 1)) ?? [];
      push(searched[0]);
    }
    push(kw);
    return titles;
  }

  // ------------------------------------------------------------ 回复与来源

  private async renderAnswer(
    session: Session | undefined,
    answer: string,
    sources: AiSource[],
    inheritedFrom?: string,
  ): Promise<string | undefined> {
    // 「资料未提及」时列出检索片段会误导用户以为这些就是答案依据
    const visible = isNoAnswer(answer) ? [] : sources.slice(0, 3);
    const inherited = inheritedFrom
      ? `💭 承接群内上一问：${inheritedFrom}`
      : undefined;

    if (this.renderer.isQQ(session)) {
      // QQ markdown 消息有长度上限，先截断正文再拼来源
      let markdown = `**🤖 AI 回答**\n${truncateForQQ(answer)}`;
      if (inherited) markdown += `\n\n> ${inherited}`;
      if (visible.length > 0) {
        markdown += `\n\n---\n> 📚 **数据来源：缺氧 BWIKI**`;
        for (const source of visible) {
          markdown += `\n> 🔗 [${source.title}](${source.url})`;
        }
      } else {
        markdown += `\n\n> 📚 数据来源：缺氧 BWIKI`;
      }
      return this.renderer.send(session, markdown);
    }

    let message = `🤖 AI 回答\n${answer}`;
    if (inherited) message += `\n\n${inherited}`;
    message += `\n\n📚 数据来源：缺氧 BWIKI`;
    for (const source of visible) {
      message += `\n🔗 ${source.title}：${source.url}`;
    }
    return message;
  }

  private pageUrl(title: string): string {
    return `${this.pageUrlBase}${encodeURIComponent(
      title.trim().replace(/ /g, "_"),
    )}`;
  }

  /** 返回剩余冷却秒数，0 表示可以提问 */
  private cooldownLeft(session: Session | undefined): number {
    const cooldown = this.config.aiCooldown * 1000;
    if (!session || cooldown <= 0) return 0;

    const key = this.sessionKey(session);
    const now = Date.now();
    const last = this.lastAskedAt.get(key) ?? 0;
    const remaining = last + cooldown - now;

    if (remaining > 0) {
      return Math.ceil(remaining / 1000);
    }

    this.lastAskedAt.set(key, now);
    if (this.lastAskedAt.size > 1000) {
      for (const [storedKey, at] of this.lastAskedAt) {
        if (now - at > cooldown * 10) this.lastAskedAt.delete(storedKey);
      }
    }
    return 0;
  }

  // ------------------------------------------------------------ 短期记忆

  /**
   * 记忆键：平台 + 频道 + 用户。
   *
   * 按用户隔离而不是按频道，避免群里 A 的追问被 B 的问题串了话题；
   * 控制台/无会话调用时返回空串，此时不记也不读。
   */
  private sessionKey(session: Session | undefined): string {
    if (!session) return "";
    return `${session.platform}:${session.channelId}:${session.userId ?? ""}`;
  }

  /** 群话题键：平台 + 频道（不含用户），用于跨用户的追问承接 */
  private channelKey(session: Session | undefined): string {
    if (!session) return "";
    return `topic:${session.platform}:${session.channelId}`;
  }

  /** 取最近的记忆：先查内存，未命中再回库（重启后仍能承接上一问） */
  private async history(session: Session | undefined): Promise<MemoryTurn[]> {
    const key = this.sessionKey(session);
    const cached = this.memory.get(key);
    if (cached.length > 0) return cached;

    const stored = await this.loadMemory(key);
    return stored.length > 0 ? this.memory.restore(key, stored) : [];
  }

  /** 群话题的读取同上 */
  private async channelHistory(
    session: Session | undefined,
  ): Promise<MemoryTurn[]> {
    const key = this.channelKey(session);
    const cached = this.channelMemory.get(key);
    if (cached.length > 0) return cached;

    const stored = await this.loadMemory(key);
    return stored.length > 0 ? this.channelMemory.restore(key, stored) : [];
  }

  /**
   * 决定这一问用哪段上下文。
   *
   * - 自己刚问过 → 用**自己的**历史（优先，避免被别人的话题带偏）；
   * - 自己没记录、且开启了 `aiChannelMemory` → 承接**群里上一轮**，
   *   这样 alice 问「氧石精炼炉是什么」，bob 接着问「那它耗电多少」也能答；
   * - 都没有 → 单轮问答。
   */
  private async resolveContext(session: Session | undefined): Promise<{
    turns: MemoryTurn[];
    inheritedFrom?: string;
  }> {
    const own = await this.history(session);
    if (own.length > 0)
      return pickContext(own, [], this.config.aiChannelMemory);

    const shared = await this.channelHistory(session);
    return pickContext([], shared, this.config.aiChannelMemory);
  }

  /** 记录一轮问答：同时写用户记忆与群话题（后者供其他人追问），并落库 */
  private remember(
    session: Session | undefined,
    question: string,
    answer: string,
    pages: string[],
  ): void {
    const turn = { question, answer, page: pages[0] };
    this.memory.add(this.sessionKey(session), turn);

    // 「未提及」的回答不构成新话题，否则群里接着问会挂到一句废话上
    if (!isNoAnswer(answer)) {
      this.channelMemory.add(this.channelKey(session), turn);
    }

    void this.persistMemory(session);
  }

  /** 从数据库读取一次记忆（重启后内存为空时使用） */
  private async loadMemory(key: string): Promise<MemoryTurn[]> {
    if (!key || this.config.aiMemoryTurns <= 0) return [];
    try {
      const rows = await this.ctx.database.get("oniaimemory", { id: key });
      const payload = rows[0]?.payload;
      if (!payload) return [];
      const parsed = JSON.parse(payload);
      return Array.isArray(parsed) ? (parsed as MemoryTurn[]) : [];
    } catch (error) {
      this.log.warn(`[ai] 读取短期记忆失败：${getErrorMessage(error)}`);
      return [];
    }
  }

  /** 把内存里的记忆写回数据库，并顺手清理过期行 */
  private async persistMemory(session: Session | undefined): Promise<void> {
    if (this.config.aiMemoryTurns <= 0) return;

    const userKey = this.sessionKey(session);
    const channelKey = this.channelKey(session);
    if (!userKey && !channelKey) return;

    try {
      const now = Date.now();
      const rows: Array<{ id: string; payload: string; updated_at: number }> =
        [];
      const push = (key: string, turns: MemoryTurn[]) => {
        if (!key || turns.length === 0) return;
        rows.push({ id: key, payload: JSON.stringify(turns), updated_at: now });
      };
      push(userKey, this.memory.get(userKey));
      push(channelKey, this.channelMemory.get(channelKey));

      if (rows.length > 0) {
        await this.ctx.database.upsert("oniaimemory", rows);
      }

      const ttl = this.config.aiMemoryTtl * 1000;
      if (ttl > 0) {
        await this.ctx.database.remove("oniaimemory", {
          updated_at: { $lt: now - ttl },
        });
      }
    } catch (error) {
      this.log.warn(`[ai] 短期记忆落库失败：${getErrorMessage(error)}`);
    }
  }
}

/** 从 tool_call 里读关键词：模型偶尔会用 `query` / `title` 之类的别名 */
function readKeyword(call: ParsedToolCall): string {
  for (const field of ["keyword", "query", "title", "name"]) {
    const value = call.args[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** QQ markdown 有长度上限：超出时截断正文，避免整条消息发不出去 */
function truncateForQQ(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
