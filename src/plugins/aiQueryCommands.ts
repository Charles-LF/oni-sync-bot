import { Context, Session } from "koishi";
import type {
  AiConfig,
  SiteConfig,
  VectorConfig,
  WikiTextConfig,
} from "../config";
import {
  AiService,
  NO_ANSWER_TEXT,
  buildMessages,
  isNoAnswer,
  type AiContextChunk,
} from "../services/aiService";
import { AiMemory, pickContext, type MemoryTurn } from "../services/aiMemory";
import { MessageRenderer } from "../services/messageRenderer";
import { buildPageUrl, RenderedTextSyncer } from "../sync/textSync";
import { tryGetBWikiBot } from "../services/wikiBotService";
import {
  generatePinyinInfo,
  getErrorMessage,
  logger,
  siteUrl,
} from "../utils/tools";
import { findFuzzyMatches } from "../utils/matcher";

export type AiQueryConfig = AiConfig &
  VectorConfig &
  Pick<
    WikiTextConfig,
    "textApiUrl" | "textTableMode" | "textMaxLength" | "textSyncInterval"
  > &
  Pick<SiteConfig, "domain" | "bwiki_site">;

/** 检索到的片段最多保留这么多字，防止提示词过长把小机器拖垮 */
const MAX_CONTEXT_CHARS = 1200;

/** 同页扩展：追问时话题页额外补几块 */
const SAME_PAGE_EXTRA = 3;

/** 宽泛问题交给模型的上下文预算（字符）与块数上限 */
const MAX_CONTEXT_BUDGET = 5000;
const MAX_CONTEXT_CHUNKS = 12;

/**
 * `.ai` 问答：本地向量检索 + DeepSeek 总结。
 *
 * 数据链路（源码永远不参与 AI）：
 * `BWiki action=parse` → HTML → 纯文本（`wikitexts` 表）→ vectra 索引 → 检索片段 → DeepSeek。
 *
 * 为什么单独做成子插件而不是塞进 QueryCommands：
 * `QueryCommands` 只依赖数据库、回复的是页面链接；AI 问答额外依赖 http + 向量库 + 外部 API，
 * 单独成插件后，任何一环没配好都不会影响原有的 `x` 拼音查询。
 */
export class AiQueryCommands {
  /** `http` / `vector` 可选：缺任意一项时 `.ai` 仍应能给出明确提示，而不是整组命令消失 */
  public static readonly inject = {
    database: { required: true },
    wikiBot: { required: false },
    http: { required: false },
    vector: { required: false },
  };

  private readonly config: AiQueryConfig;
  private readonly renderer: MessageRenderer;
  private readonly ai: AiService;
  private readonly textSync: RenderedTextSyncer;
  private readonly pageUrlBase: string;
  /** 用户 → 上次提问时间，用于冷却 */
  private readonly lastAskedAt = new Map<string, number>();
  /** 用户 → 最近几轮问答（含当轮检索到的资料），用于追问 */
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

    const bwiki = siteUrl(config.bwiki_site || "wiki.biligame.com/oni");
    this.pageUrlBase = `${bwiki}/`;
    this.memory = new AiMemory(config.aiMemoryTurns, config.aiMemoryTtl * 1000);
    // 群内话题只承接「上一轮」，且与用户记忆同 TTL，避免不同人的话题互相串
    this.channelMemory = new AiMemory(
      Math.min(1, Math.max(0, config.aiMemoryTurns)),
      config.aiMemoryTtl * 1000,
    );
    this.textSync = new RenderedTextSyncer({
      http: ctx.http,
      // 惰性取用已登录的 bwiki 客户端：构造时登录通常还没完成
      bot: () => tryGetBWikiBot(ctx),
      database: ctx.database,
      vector: config.vectorEnabled ? ctx.vector : undefined,
      options: {
        apiUrl: config.textApiUrl || `${bwiki}/api.php`,
        pageUrlBase: this.pageUrlBase,
        tableMode: config.textTableMode,
        maxLength: config.textMaxLength,
        interval: config.textSyncInterval,
      },
    });

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
        const chunks = await this.retrieve(keyword, context.turns);
        if (chunks.length === 0) {
          logger.info(`[ai] 「${keyword}」未检索到资料，直接返回未提及`);
          return this.renderer.send(
            session,
            `${NO_ANSWER_TEXT}\n\n数据来源：缺氧 BWIKI`,
          );
        }

        try {
          const answer = await this.ai.chat(
            buildMessages(
              keyword,
              chunks,
              context.turns.map((turn) => ({
                question: turn.question,
                answer: turn.answer,
              })),
            ),
          );
          this.remember(session, keyword, answer, chunks);
          return this.renderAnswer(
            session,
            answer,
            chunks,
            context.inheritedFrom,
          );
        } catch (error) {
          logger.error(
            `[ai] 「${keyword}」回答失败：${getErrorMessage(error)}`,
          );
          return this.renderer.send(
            session,
            "❌ AI 服务暂时不可用，请稍后再试（管理员可查看日志）",
          );
        }
      });

    ctx
      .command("ai.status", "查看 AI 问答与向量索引状态", { authority: 1 })
      .action(async () => {
        const stats = this.ctx.vector
          ? await this.ctx.vector.stats()
          : { enabled: false, path: "-", items: 0, bytes: 0 };
        const rows = await ctx.database.get("wikitexts", {}, ["id"]);
        const indexSize = `${(stats.bytes / 1024 / 1024).toFixed(1)} MB`;

        const lines = [
          "📊 AI 问答状态",
          `├─ AI 问答：${this.ai.enabled ? "✅ 已启用" : "❌ 未配置 API Key"}`,
          `├─ 模型：${this.config.deepseekModel}`,
          `├─ 向量检索：${stats.enabled ? "✅ 已启用" : "❌ 已关闭"}`,
          `├─ Embedding：${this.config.embeddingModel}（${this.config.embeddingDtype}）`,
          `├─ 索引目录：${stats.path}`,
          `├─ 索引文本块：${stats.items}`,
          `├─ 索引体积：${indexSize}`,
          `├─ 会话记忆：${
            this.config.aiMemoryTurns > 0
              ? `${this.config.aiMemoryTurns} 轮 / ${Math.round(this.config.aiMemoryTtl / 60)} 分钟`
              : "已关闭"
          }`,
          `├─ 群内追问：${this.config.aiChannelMemory && this.config.aiMemoryTurns > 0 ? "✅ 开启" : "❌ 关闭"}`,
          `└─ 已入库页面：${rows.length}`,
        ];
        if (stats.items > 20000) {
          lines.push(
            "",
            `⚠️ 索引已较大（${stats.items} 个文本块，约 ${indexSize}），`,
            "2G 内存机器建议把 maxChunksPerPage 调到 12 后执行 ai.reindex。",
          );
        }
        return lines.join("\n");
      });

    ctx
      .command(
        "ai.sync [pageTitle:text]",
        "抓取 BWiki 渲染文本（不填页面则全量）",
        {
          authority: 4,
        },
      )
      .action(async ({ session }, pageTitle) => {
        const title = (pageTitle ?? "").trim();
        const syncer = this.textSync;

        if (title) {
          const result = await syncer.syncOne(title);
          if (!result.success) {
            return this.renderer.send(
              session,
              `❌ 页面「${title}」渲染文本抓取失败：${result.reason}${result.message ? `（${result.message}）` : ""}`,
            );
          }
          return this.renderer.send(
            session,
            result.reason === "synced"
              ? `✅ 页面「${title}」的渲染文本已更新并写入索引`
              : `🟡 页面「${title}」的正文没有变化，已跳过`,
          );
        }

        await session?.send(
          "🚀 开始全量抓取 BWiki 渲染文本，耗时较长，完成后我会再回复一次",
        );

        let summary;
        try {
          summary = await syncer.syncAll();
        } catch (error) {
          logger.error(`[ai] 全量渲染文本抓取失败：${getErrorMessage(error)}`);
          return this.renderer.send(
            session,
            `❌ 全量抓取失败：${getErrorMessage(error)}`,
          );
        }

        logger.info(`[ai] 全量渲染文本抓取完成：${JSON.stringify(summary)}`);

        if (summary.total === 0) {
          return this.renderer.send(
            session,
            "❌ 没有抓到任何页面：BWiki 的 allpages 查询为空，请检查 textApiUrl / 网络",
          );
        }

        return this.renderer.send(
          session,
          `✅ 渲染文本抓取完成\n├─ 总计：${summary.total} 个页面\n├─ 新增/更新：${summary.synced}\n├─ 未变化：${summary.unchanged}\n├─ 页面不存在：${summary.missing}\n└─ 失败：${summary.failed}`,
        );
      });

    ctx
      .command("ai.reindex", "用本地已存的正文重建向量索引", { authority: 4 })
      .action(async ({ session }) => {
        const vector = this.ctx.vector;
        if (!this.config.vectorEnabled || !vector) {
          return this.renderer.send(
            session,
            "❌ 向量检索未启用（vectra 未加载或 vectorEnabled=false）",
          );
        }

        const rows = await ctx.database.get("wikitexts", {});
        if (rows.length === 0) {
          return this.renderer.send(
            session,
            "❌ 本地还没有渲染文本，请先执行 ai.sync",
          );
        }

        await session?.send(
          `🚀 开始重建向量索引（${rows.length} 个页面），请耐心等待`,
        );
        await vector.reset();

        let chunks = 0;
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index];
          chunks += await vector.indexPage({
            id: row.id,
            title: row.title || row.id,
            url: this.pageUrl(row.id),
            text: row.text,
          });
          if ((index + 1) % 20 === 0 || index === rows.length - 1) {
            logger.info(
              `[ai] 索引重建进度 ${index + 1}/${rows.length}（${chunks} 个文本块）`,
            );
          }
        }

        return this.renderer.send(
          session,
          `✅ 向量索引重建完成：${rows.length} 个页面 / ${chunks} 个文本块`,
        );
      });
  }

  // ------------------------------------------------------------ 检索与回复

  /**
   * 检索当前问题需要的资料。
   *
   * 单靠相似度只能拿到页面的一两段（「电解器能干哈」原本只回 5 块，自动化、技巧都进不了
   * 提示词），因此这里分三种情况补全：
   * 1. 把上一轮问题拼进检索串，让 Embedding 仍然指向同一个对象；
   * 2. 确定**话题页**：优先上一轮记忆；其次问题里直接点名的页面
   *    （「氧石精炼炉怎么用」→ `氧石精炼炉`）；最后才看本轮命中里多数块来自哪一页。
   *    话题页的**第 0 块（信息框/简介）一定钉进上下文**——耗电、产热、尺寸这些单点数值
   *    在相似度排序里只排第 4~5，靠排名召回太脆弱；
   * 3. 追问时只补该页最相关的几块（保持聚焦）；其余情况按字符预算把**整页**交给模型；
   * 4. 本轮真的什么都没检索到时，沿用上一轮的资料，避免直接答「未提及」。
   */
  private async retrieve(
    question: string,
    history: MemoryTurn[] = [],
  ): Promise<AiContextChunk[]> {
    const topK = this.config.retrieveTopK;
    const query = this.buildRetrievalQuery(question, history);

    const chunks = await this.searchChunks(query, topK);
    const followUpTopic = this.topicOf(history);
    let topics: string[] = [];
    if (followUpTopic) {
      topics = [followUpTopic];
    } else {
      const subjects = await this.subjectPages(question);
      const dominant = this.dominantDocument(chunks);
      topics = subjects.length > 0 ? subjects : dominant ? [dominant] : [];
    }

    const merged: AiContextChunk[] = [];
    let budget = MAX_CONTEXT_BUDGET;
    const push = (chunk: AiContextChunk) => {
      if (!chunk.text || budget <= 0) return;
      if (merged.some((item) => item.text === chunk.text)) return;
      budget -= chunk.text.length;
      merged.push(chunk);
    };
    const toChunk = (hit: {
      documentId: string;
      title: string;
      url: string;
      text: string;
    }): AiContextChunk => ({
      title: hit.title,
      url: hit.url || this.pageUrl(hit.documentId),
      text: hit.text,
      documentId: hit.documentId,
    });

    for (const topic of topics) {
      if (!this.ctx.vector) break;
      try {
        const pinned = await this.ctx.vector.getChunk(topic, 0);
        if (pinned) push(toChunk(pinned));

        if (followUpTopic) {
          // 追问：问题很具体，只补该页最相关的几块，避免无关段落稀释回答
          const scoped = await this.ctx.vector.search(query, SAME_PAGE_EXTRA, {
            documentId: topic,
          });
          for (const hit of scoped) push(toChunk(hit));
        } else {
          // 点名了对象（或命中集中在某页）：整页都在预算内，全给模型
          const page = await this.ctx.vector.listPageChunks(topic);
          for (const hit of page) push(toChunk(hit));
        }
      } catch (error) {
        logger.debug(`[ai] 同页扩展失败：${getErrorMessage(error)}`);
      }
    }

    for (const chunk of chunks) push(chunk);

    if (merged.length > 0) {
      const limit = followUpTopic ? topK + 2 : MAX_CONTEXT_CHUNKS;
      return merged.slice(0, limit);
    }

    const previous = history[history.length - 1];
    if (previous?.chunks.length) {
      logger.info(
        `[ai] 「${question}」未检索到新资料，沿用上一轮「${previous.question}」的片段`,
      );
      return previous.chunks.slice(0, topK);
    }
    return [];
  }

  /**
   * 问题里直接点名的页面标题（最多 2 个）。
   *
   * 「氧石精炼炉怎么用」这类问题，Embedding 会把资料拆到氧石精炼炉、铁、绿叶小行星几页，
   * 真正的主体反而只召回 1 块。标题里出现的词是确定性信号，比相似度可靠。
   */
  private async subjectPages(question: string): Promise<string[]> {
    let pages: Array<{ title: string }>;
    try {
      pages = await this.ctx.database.get("wikipages", {});
    } catch (error) {
      logger.debug(`[ai] 读取页面列表失败：${getErrorMessage(error)}`);
      return [];
    }

    const matched = pages
      .map((page) => page.title)
      .filter((title) => title.length >= 2 && question.includes(title))
      // 长的优先：「氧石精炼炉」命中后，不必再拿「氧石」当主题
      .sort((a, b) => b.length - a.length);

    const picked: string[] = [];
    for (const title of matched) {
      if (picked.some((kept) => kept.includes(title))) continue;
      picked.push(title);
      if (picked.length >= 2) break;
    }
    return picked;
  }

  /** 取上一轮话题页的 id（用于钉住该页的基础数据块） */
  private topicOf(history: MemoryTurn[]): string | undefined {
    const chunk = history[history.length - 1]?.chunks[0];
    if (!chunk) return undefined;
    return chunk.documentId || chunk.title || undefined;
  }

  /** 本轮命中里「多数块来自同一页」时，把该页当作话题页（宽泛问题的场景） */
  private dominantDocument(chunks: AiContextChunk[]): string | undefined {
    if (chunks.length < 3) return undefined;

    const counts = new Map<string, number>();
    for (const chunk of chunks) {
      const id = chunk.documentId || chunk.title;
      if (!id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    let best: string | undefined;
    let bestCount = 0;
    for (const [id, count] of counts) {
      if (count > bestCount) {
        best = id;
        bestCount = count;
      }
    }
    // 用「过半」而不是「≥2」：比较类问题（电解器 vs 气泵）里最热门的页面
    // 往往只多出一块，扩展它会挤掉另一页的资料
    return bestCount * 2 > chunks.length ? best : undefined;
  }

  /** 把上一轮问题并入检索串；保留结尾（即当前问题）优先 */
  private buildRetrievalQuery(question: string, history: MemoryTurn[]): string {
    if (history.length === 0) return question;
    const merged = `${history[history.length - 1].question} ${question}`.trim();
    return merged.length > 150 ? merged.slice(-150) : merged;
  }

  private async searchChunks(
    query: string,
    topK: number,
  ): Promise<AiContextChunk[]> {
    const vector = this.ctx.vector;

    if (this.config.vectorEnabled && vector) {
      try {
        const hits = await vector.search(query, topK);
        if (hits.length > 0) {
          return hits.map((hit) => ({
            title: hit.title,
            url: hit.url || this.pageUrl(hit.documentId),
            text: hit.text,
            documentId: hit.documentId,
          }));
        }
      } catch (error) {
        logger.warn(
          `[ai] 向量检索失败，改用标题匹配兜底：${getErrorMessage(error)}`,
        );
      }
    }

    return this.fallbackRetrieve(query, topK);
  }

  private async fallbackRetrieve(
    question: string,
    limit: number,
  ): Promise<AiContextChunk[]> {
    const pages = await this.ctx.database.get("wikipages", {});
    if (pages.length === 0) return [];

    const queryKey = question.toLowerCase();
    const { pinyin_full, pinyin_first } = generatePinyinInfo(question);
    const matches = findFuzzyMatches(
      pages,
      queryKey,
      pinyin_full,
      pinyin_first,
      limit,
    );

    const chunks: AiContextChunk[] = [];
    for (const match of matches) {
      const rows = await this.ctx.database.get("wikitexts", {
        id: match.title,
      });
      const row = rows[0];
      if (!row?.text) continue;
      chunks.push({
        title: row.title || match.title,
        url: this.pageUrl(match.title),
        text: row.text.slice(0, MAX_CONTEXT_CHARS),
        documentId: match.title,
      });
    }
    return chunks;
  }

  private async renderAnswer(
    session: Session | undefined,
    answer: string,
    chunks: AiContextChunk[],
    inheritedFrom?: string,
  ): Promise<string | undefined> {
    // 「资料未提及」时列出检索片段会误导用户以为这些就是答案依据
    const noAnswer = isNoAnswer(answer);
    const sources: Array<{ title: string; url: string }> = [];
    if (!noAnswer) {
      for (const chunk of chunks) {
        if (sources.some((source) => source.title === chunk.title)) continue;
        sources.push({ title: chunk.title, url: chunk.url || "" });
        if (sources.length >= 3) break;
      }
    }

    const inherited = inheritedFrom
      ? `💭 承接群内上一问：${inheritedFrom}`
      : undefined;

    if (this.renderer.isQQ(session)) {
      // QQ markdown 消息有长度上限，先截断正文再拼来源
      let markdown = `**🤖 AI 回答**\n${truncateForQQ(answer)}`;
      if (inherited) markdown += `\n\n> ${inherited}`;
      if (sources.length > 0) {
        markdown += `\n\n---\n> 📚 **数据来源：缺氧 BWIKI**`;
        for (const source of sources) {
          markdown += source.url
            ? `\n> 🔗 [${source.title}](${source.url})`
            : `\n> 🔗 ${source.title}`;
        }
      } else {
        markdown += `\n\n> 📚 数据来源：缺氧 BWIKI`;
      }
      return this.renderer.send(session, markdown);
    }

    let message = `🤖 AI 回答\n${answer}`;
    if (inherited) message += `\n\n${inherited}`;
    if (sources.length === 0) {
      message += `\n\n📚 数据来源：缺氧 BWIKI`;
      return message;
    }
    message += `\n\n📚 数据来源：缺氧 BWIKI`;
    for (const source of sources) {
      message += source.url
        ? `\n🔗 ${source.title}：${source.url}`
        : `\n🔗 ${source.title}`;
    }
    return message;
  }

  private pageUrl(title: string): string {
    return buildPageUrl(this.pageUrlBase, title);
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
    chunks: AiContextChunk[],
  ): void {
    const turn = { question, answer, chunks };
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
      logger.warn(`[ai] 读取短期记忆失败：${getErrorMessage(error)}`);
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
      logger.warn(`[ai] 短期记忆落库失败：${getErrorMessage(error)}`);
    }
  }
}

/** QQ markdown 有长度上限：超出时截断正文，避免整条消息发不出去 */
function truncateForQQ(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
