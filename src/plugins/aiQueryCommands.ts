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

/** 单轮最多执行的检索数（比较类问题 2 个足够，更多请分轮） */
const MAX_TOOL_CALLS_PER_ROUND = 2;

/** 单次问答累计最多抓取多少个不同页面，防止模型无限发散 */
const MAX_PAGES_PER_QUESTION = 6;

/** 兜底轮数：配置缺失或非法时使用 */
const DEFAULT_MAX_TOOL_ROUNDS = 5;

/** 拼音模糊匹配的最低分：6 分只是「首字母包含」，不可信 */
const MIN_FUZZY_SCORE = 8;

/** 候选词上限 / 全文检索上限 / 正文抓取上限：限制单次问答的请求数 */
const MAX_TITLE_CANDIDATES = 3;
const MAX_TITLE_SEARCH = 2;
const MAX_PAGE_FETCH = 4;

/**
 * 纯追问判定的词表（指代 + 疑问 + 属性）。
 *
 * 必须按长度降序匹配（「建筑材料」先于「材料」）；
 * 不要放会切坏实体名的单字（干板墙 / 高压制氧 / 小行星 / 大嘴鱼）。
 */
const FOLLOW_UP_WORDS = [
  // 指代
  "这个", "那个", "这件", "那件", "这些", "那些", "这种", "那种", "这", "那", "该", "此",
  "它", "他", "她",
  // 疑问 / 语气 / 连接
  "怎么样", "怎么办", "为什么", "是什么", "有什么", "能不能", "可不可以", "是不是", "有没有",
  "哪个", "哪些", "干什么", "干嘛", "干哈", "干啥", "怎么用", "怎么", "怎样", "如何",
  "什么", "多少", "多久", "几个", "几点", "能干", "能", "可以", "会", "要", "需要",
  "吗", "呢", "吧", "啊", "呀", "的", "了", "和", "与", "跟",
  "用", "用处", "用法", "用途", "作用", "效果", "详情", "介绍", "说明", "信息", "资料", "情况",
  // 常见属性名（缺氧词条信息框里的字段）
  "建筑材料", "材料", "耗电", "费电", "电力", "功耗", "用电", "功率",
  "产热", "发热", "热量", "温度", "过热", "低温",
  "建造", "科技", "类别", "类型", "尺寸", "大小", "装饰度", "装饰",
  "血量", "耐久", "寿命", "效率", "速度", "产量", "消耗", "产出", "容量", "存储", "重量", "质量",
  "机制", "技巧", "原理", "区别", "对比", "优缺点", "优点", "缺点", "好处", "坏处",
  "值得", "合适", "推荐", "拿来", "用来",
].sort((a, b) => b.length - a.length);

/** 剔掉指代/疑问/属性词后剩下的实体部分：「耗电多少」→ ""，「水泵有什么用」→「水泵」 */
export function residualSubject(keyword: string): string {
  let rest = keyword ?? "";
  for (const word of FOLLOW_UP_WORDS) {
    if (rest.includes(word)) rest = rest.split(word).join("");
  }
  return rest.replace(/[\s\p{P}\p{S}]/gu, "");
}

/** 是否只能靠上一轮话题回答：点名了上一轮页面，或剔完不剩实体 */
export function isPureFollowUp(
  keyword: string,
  previousPage?: string,
): boolean {
  const kw = (keyword ?? "").trim();
  if (!kw) return true;
  if (previousPage && kw.includes(previousPage)) return true;
  return residualSubject(kw) === "";
}

/** 交给 DeepSeek 的工具声明 */
const SEARCH_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: SEARCH_TOOL_NAME,
    description:
      "检索缺氧中文 BWIKI 的某个词条正文（模板与模块已展开，包含信息框里的耗电、产热、尺寸、材料等数值）。" +
      "复合问题请拆成多个词条、分多轮调用：例如算「电解器能供几个复制人」时，先查「电解器」，再查「复制人」。",
    parameters: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description:
            "游戏内专有名词，只能是一个词条名（如「电解器」「氧石精炼炉」「复制人」）。" +
            "禁止传整句问题、问句片段或口语描述（不要出现「怎么」「多少」「哪个」「有什么用」）。",
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
  /** 本轮查过的页面（写入记忆，供下一轮兜底） */
  pages: string[];
  /** 真正复用了上一轮页面时才有的标记，用于决定回复里是否标注「承接」 */
  reusedPage?: string;
}

/** 一次 `searchPage` 的结果 */
interface PageLookup {
  title: string;
  text: string;
  /** 是否沿用上一轮页面（而非本轮新检索到的） */
  reused?: boolean;
}

/** 一次问答跨轮累计的检索状态 */
interface ToolRunState {
  sources: AiSource[];
  pages: string[];
  /** 已抓取的不同页面数（用于总量预算） */
  fetched: number;
  reusedPage?: string;
}

/** 轮数兜底：配置缺失/非法时回落到默认值，并限制在 1~8 之间 */
function clampRounds(value: number | undefined): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_MAX_TOOL_ROUNDS;
  return Math.min(8, Math.max(1, Math.floor(numeric)));
}

/** 这一问可用的历史上下文 */
interface ResolvedContext {
  turns: MemoryTurn[];
  /** 群内上一问的原话（用于回复里标注来源） */
  inheritedFrom?: string;
  /** 历史来自群内别人的问答：只回放问题，不回放答案 */
  shared: boolean;
}

/**
 * `.ai` 问答：模型发起 `search_oni_bwiki(keyword)` → 拼音匹配出标题 →
 * `fetchPagePlainText` 取正文 → `role:'tool'` 回填 → 模型出终稿。
 */
export class AiQueryCommands {
  /** wikiBot / http 可选：缺失时 `.ai` 给出提示，而不是整组命令消失 */
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
  /** 用户 → 上次提问时间（冷却） */
  private readonly lastAskedAt = new Map<string, number>();
  /** 用户 → 最近几轮问答 */
  private readonly memory: AiMemory;
  /** 频道 → 最近一轮问答（供群内追问承接） */
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
    // 群话题只保留 1 轮，TTL 与用户记忆一致
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

        const context = await this.resolveContext(session, keyword);

        try {
          const result = await this.runAgent(
            keyword,
            context.turns,
            context.shared,
          );
          this.remember(session, keyword, result.answer, result.pages);
          // 只有真正沿用了上一轮的页面才标注「承接」，独立检索到新页面时不标注，
          // 否则用户会以为这一问还在聊上一轮的对象。
          return this.renderAnswer(
            session,
            result.answer,
            result.sources,
            result.reusedPage ? context.inheritedFrom : undefined,
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
          `├─ 多轮检索：最多 ${clampRounds(this.config.aiMaxToolRounds)} 轮（单轮 ≤ ${MAX_TOOL_CALLS_PER_ROUND} 次，累计 ≤ ${MAX_PAGES_PER_QUESTION} 个页面）`,
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
   * 一次 Agent 问答：**多轮工具调用循环**。
   *
   * 1. 每轮 `tool_choice:'auto'`，模型可以发起 1~2 个检索；
   * 2. 程序执行检索，把结果以 `role:'tool'` 回填，再让模型继续；
   * 3. 模型不再发起 `tool_calls` 时，它这一轮的内容就是最终回答（资料已在上下文里）；
   * 4. 达到 `aiMaxToolRounds` 上限时，追加收尾提示并强制 `tool_choice:'none'`，
   *    防止死循环，同时保证一定拿得到文本。
   *
   * 首轮没检索的兜底与旧版一致：用 `'required'` 逼它查一次，仍失败则退回直接回答。
   */
  private async runAgent(
    question: string,
    turns: MemoryTurn[] = [],
    shared = false,
  ): Promise<AgentAnswer> {
    const history: AgentMessage[] = [];

    if (shared) {
      // 群内别人的问答只取问题，答案正文可能是另一套资料，回放会被当成当前事实
      const last = [...turns].reverse().find((turn) => turn.question);
      if (last) {
        history.push({
          role: "system",
          content: `【群内上一问（只用于判断「它」「这个」指代谁，不是当前问题）】${last.question}`,
        });
      }
    } else {
      for (const turn of turns) {
        if (!turn.question || !turn.answer) continue;
        // 「未提及」的轮次没有信息，回放只会诱发继续答未提及
        if (isNoAnswer(turn.answer)) continue;
        history.push({ role: "user", content: turn.question });
        history.push({ role: "assistant", content: clipAnswer(turn.answer) });
      }
    }

    const messages: AgentMessage[] = [
      { role: "system", content: AGENT_SYSTEM_PROMPT },
      ...history,
      { role: "user", content: question },
    ];

    const state: ToolRunState = {
      sources: [],
      pages: [],
      fetched: 0,
      reusedPage: undefined,
    };
    const maxRounds = clampRounds(this.config.aiMaxToolRounds);
    let forcedSearch = false;

    for (let round = 1; round <= maxRounds; round++) {
      const isLast = round === maxRounds;
      if (isLast) {
        // 最后一轮说清楚「不许再查了，用已有资料作答」，顺便把推导规则再强调一次
        messages.push({ role: "system", content: ANSWER_SYSTEM_PROMPT });
      }

      let decision = await this.ai.complete(messages, {
        tools: [SEARCH_TOOL],
        toolChoice: isLast ? "none" : "auto",
      });

      // 首轮完全没检索：补一次强制检索（兼容不支持 required 的服务端）
      // 最后一轮已经强制 "none"，不再反向逼它检索，否则白跑一次
      if (
        decision.toolCalls.length === 0 &&
        round === 1 &&
        !isLast &&
        !forcedSearch
      ) {
        forcedSearch = true;
        this.log.info(`[ai] 模型未调用工具，改为强制检索：${question}`);
        try {
          const forced = await this.ai.complete(messages, {
            tools: [SEARCH_TOOL],
            toolChoice: "required",
          });
          if (forced.toolCalls.length === 0) {
            return this.finalize(
              question,
              forced.content || decision.content,
              state,
              false,
            );
          }
          decision = forced;
        } catch (error) {
          // 兼容层可能不支持 'required'，别让它拖垮整次问答
          this.log.warn(
            `[ai] 强制检索调用失败，回退为直接回答：${getErrorMessage(error)}`,
          );
          return this.finalize(question, decision.content, state, false);
        }
      }

      if (decision.toolCalls.length === 0) {
        // 模型自己决定收尾：这一轮的内容就是答案
        return this.finalize(question, decision.content, state, state.fetched > 0);
      }

      if (isLast) {
        // 理论上 tool_choice:'none' 不会再给 tool_calls；真给了也不能执行，
        // 否则循环就破了。直接要求它把已有资料说清楚。
        this.log.warn(`[ai] 最后一轮仍返回 tool_calls，忽略并强制收尾`);
        const fallback = await this.ai.complete(messages, {
          tools: [SEARCH_TOOL],
          toolChoice: "none",
        });
        return this.finalize(question, fallback.content, state, state.fetched > 0);
      }

      messages.push(decision.message);
      messages.push(...(await this.executeToolCalls(decision.toolCalls, turns, state)));
      this.log.debug(
        `[ai] 第 ${round} 轮检索完成，累计页面：${state.pages.join("、") || "（无）"}`,
      );
    }

    // 循环正常不会走到这里（最后一轮已强制收尾），兜底给一句「未提及」
    return this.finalize(question, "", state, state.fetched > 0);
  }

  /**
   * 执行一轮里的 tool_calls，返回要回填给模型的 `role:'tool'` 消息。
   *
   * 结构约束：**每个 tool_call 都必须有一条对应回复**，否则服务端会 400；
   * 超出预算（单轮 2 个 / 单次问答 6 个）的调用也要补一条说明。
   */
  private async executeToolCalls(
    calls: ParsedToolCall[],
    turns: MemoryTurn[],
    state: ToolRunState,
  ): Promise<AgentMessage[]> {
    const messages: AgentMessage[] = [];

    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];

      if (index >= MAX_TOOL_CALLS_PER_ROUND) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `（单轮最多检索 ${MAX_TOOL_CALLS_PER_ROUND} 个词条，本条已跳过；需要更多资料请在下一轮继续）`,
        });
        continue;
      }

      const keyword = readKeyword(call);
      if (!keyword) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content:
            "（未提供 keyword，本次未检索；请只传游戏专有名词，如「电解器」）",
        });
        continue;
      }

      if (state.fetched >= MAX_PAGES_PER_QUESTION) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `（单次问答最多检索 ${MAX_PAGES_PER_QUESTION} 个词条，本条已跳过）`,
        });
        continue;
      }

      const page = await this.searchPage(keyword, turns);
      if (!page) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `未找到与「${keyword}」相关的 BWIKI 页面。`,
        });
        continue;
      }

      // 同一页面重复检索：不再重复灌一遍正文，省 token 也避免模型以为拿到了新资料
      if (state.pages.includes(page.title)) {
        if (page.reused) state.reusedPage = page.title;
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `页面「${page.title}」的正文已在上文提供，请直接使用上文资料。`,
        });
        continue;
      }

      state.fetched += 1;
      state.pages.push(page.title);
      state.sources.push({ title: page.title, url: this.pageUrl(page.title) });
      if (page.reused) state.reusedPage = page.title;

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: `页面：${page.title}\n链接：${this.pageUrl(page.title)}\n---\n${page.text}`,
      });
    }

    return messages;
  }

  /** 统一收尾日志与返回结构 */
  private finalize(
    question: string,
    content: string,
    state: ToolRunState,
    grounded: boolean,
  ): AgentAnswer {
    const answer = content?.trim() || NO_ANSWER_TEXT;
    if (!grounded) {
      this.log.warn(
        `[ai] 「${question}」没有产生检索调用，直接采用模型回答（可能不含资料支撑）`,
      );
    }
    this.log.info(
      `[ai] 「${question}」→ 检索 ${state.pages.join("、") || "（无）"}` +
        `${state.reusedPage ? `（沿用上一轮 ${state.reusedPage}）` : ""}，回答 ${answer.length} 字`,
    );
    return {
      answer,
      sources: state.sources,
      pages: state.pages,
      reusedPage: state.reusedPage,
    };
  }

  /**
   * 按关键词取页面正文（候选逐个尝试，第一个抓到即为结果）。
   *
   * 兜底只在**纯追问**时启用：群里刚聊过氧石精炼炉，接着问「水泵有什么用」
   * 若拿氧石精炼炉的正文作答就是答非所问，因此宁可回「未提及」。
   */
  private async searchPage(
    keyword: string,
    turns: MemoryTurn[],
  ): Promise<PageLookup | null> {
    const wikiBot = this.ctx.wikiBot;
    if (!wikiBot) {
      this.log.warn("[ai] 未启用 wikiBot 服务，无法获取 BWiki 正文");
      return null;
    }

    const titles = (await this.resolveTitles(keyword)).slice(0, MAX_PAGE_FETCH);
    for (const title of titles) {
      const text = await wikiBot.fetchPagePlainText(title);
      if (text) {
        this.log.info(`[ai] Agent 决定检索: ${title}（关键词「${keyword}」）`);
        return { title, text };
      }
    }

    // 追问兜底：取最近一轮真正查到过页面的记录
    const previous = [...turns].reverse().find((turn) => turn.page)?.page;
    if (!previous) {
      this.log.info(`[ai] 未找到「${keyword}」对应页面`);
      return null;
    }

    if (!isPureFollowUp(keyword, previous)) {
      this.log.info(
        `[ai] 关键词「${keyword}」自带新实体且无对应页面，不使用上一轮资料（${previous}）`,
      );
      return null;
    }

    if (titles.includes(previous)) {
      this.log.info(`[ai] 未找到「${keyword}」对应页面`);
      return null;
    }

    const text = await wikiBot.fetchPagePlainText(previous);
    if (!text) {
      this.log.info(`[ai] 未找到「${keyword}」对应页面`);
      return null;
    }

    this.log.info(`[ai] 追问「${keyword}」未命中新页面，沿用上一轮: ${previous}`);
    return { title: previous, text, reused: true };
  }

  /**
   * 关键词 → 候选标题：精确标题 → 拼音模糊（门槛 8）→ wiki 全文检索 → 原样当标题。
   * 候选 = 整句 + 按空格/标点拆出的片段；全文检索只对前 2 个候选发起。
   */
  private async resolveTitles(keyword: string): Promise<string[]> {
    const kw = keyword.trim();
    if (!kw) return [];

    const titles: string[] = [];
    const push = (title?: string) => {
      const value = title?.trim();
      if (value && !titles.includes(value)) titles.push(value);
    };

    const candidates: string[] = [];
    for (const candidate of [
      kw,
      ...kw.split(/[\s，,、。？?！!：:；;“”"'（）()]+/),
    ]) {
      const value = candidate.trim();
      if (value && !candidates.includes(value)) candidates.push(value);
      if (candidates.length >= MAX_TITLE_CANDIDATES) break;
    }

    try {
      const pages = await this.ctx.database.get("wikipages", {});
      if (pages.length > 0) {
        for (const candidate of candidates) {
          push(pages.find((page) => page.title === candidate)?.title);
        }

        for (const candidate of candidates) {
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

    for (const candidate of candidates.slice(0, MAX_TITLE_SEARCH)) {
      const searched =
        (await this.ctx.wikiBot?.searchPageTitles(candidate, 1)) ?? [];
      push(searched[0]);
    }

    // 纯属性/指代词不可能是页面名，精确匹配早已覆盖，别再白抓一次 404
    for (const candidate of candidates) {
      if (residualSubject(candidate) === "") continue;
      push(candidate);
    }
    return titles;
  }

  // ------------------------------------------------------------ 回复与来源

  /** 组装回复：QQ 长回答塞进代码块（折叠成可复制卡片），短回答走普通 markdown */
  private async renderAnswer(
    session: Session | undefined,
    answer: string,
    sources: AiSource[],
    inheritedFrom?: string,
  ): Promise<string | undefined> {
    // 「未提及」时列来源会误导用户以为那就是依据
    const visible = isNoAnswer(answer) ? [] : sources.slice(0, 3);
    const inherited = inheritedFrom
      ? `💭 承接群内上一问：${inheritedFrom}`
      : undefined;

    if (this.renderer.isQQ(session)) {
      // QQ markdown 有长度上限，先截断正文
      const body = truncateForQQ(answer);
      const threshold = this.config.aiCodeBlockMinChars;
      const asBlock = threshold > 0 && body.length >= threshold;
      const text = asBlock ? toBlockText(body) : body;

      let markdown = "**🤖 AI 回答**\n";
      markdown += asBlock ? wrapCodeBlock(text) : text;
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
   * 记忆键 = 平台 + 频道 + 用户（按用户隔离，避免群里互相串话题）。
   * 无会话时返回空串，此时不记也不读。
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
   * 只在**纯追问**时加载历史，这是多人聊天不串台的关键：
   * 自带实体的问题（「水泵有什么用」）零历史、独立检索；
   * 自己的历史同样处理，换话题时不回放自己的上一问。
   */
  private async resolveContext(
    session: Session | undefined,
    question: string,
  ): Promise<ResolvedContext> {
    const own = await this.history(session);
    const shared = await this.channelHistory(session);

    // 最近一个查到过页面的轮次，用于判断这一问是不是在指它
    const recentPage = [...own, ...shared]
      .reverse()
      .find((turn) => turn.page)?.page;

    if (!isPureFollowUp(question, recentPage)) {
      return { turns: [], shared: false };
    }

    if (own.length > 0) return { turns: own, shared: false };

    const picked = pickContext([], shared, this.config.aiChannelMemory);
    return {
      turns: picked.turns,
      inheritedFrom: picked.inheritedFrom,
      shared: true,
    };
  }

  /**
   * 记录一轮问答（同时落库）。
   * 群话题只在真的查到页面时才更新，否则没命中的追问会把有效话题冲掉。
   */
  private remember(
    session: Session | undefined,
    question: string,
    answer: string,
    pages: string[],
  ): void {
    const turn = { question, answer, page: pages[0] };
    this.memory.add(this.sessionKey(session), turn);

    // 「未提及」或没查到页面的回答不构成新话题，否则群里接着问会挂到一句废话上
    if (!isNoAnswer(answer) && pages.length > 0) {
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

/** 从 tool_call 里读关键词（兼容 query / title 这类别名） */
function readKeyword(call: ParsedToolCall): string {
  for (const field of ["keyword", "query", "title", "name"]) {
    const value = call.args[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** QQ markdown 有长度上限，超出先截断 */
function truncateForQQ(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 回放历史时旧答案保留的字数 */
const HISTORY_ANSWER_CHARS = 200;

function clipAnswer(answer: string): string {
  const text = answer.trim();
  return text.length <= HISTORY_ANSWER_CHARS
    ? text
    : `${text.slice(0, HISTORY_ANSWER_CHARS)}…`;
}

/** 去掉 markdown 标记，让正文在代码块里也是干净文本 */
export function toBlockText(text: string): string {
  return text
    // 只把「### 标题」当标题，避免误伤「#1 号管道」
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    // 落单的 ** 也去掉，否则卡片里会露星号
    .replace(/\*\*/g, "")
    // 只把「- 」这种带空格的当列表，避免误伤「-10（范围 2 格）」
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ")
    .replace(/\[([^\]\n]+)\]\([^)\s]*\)/g, "$1")
    .trim();
}

/** 用代码块包裹正文；围栏比正文里最长的连续反引号多一个，避免提前闭合 */
export function wrapCodeBlock(text: string): string {
  const runs: string[] = text.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}
