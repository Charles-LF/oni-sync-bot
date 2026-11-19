import { Context } from "koishi";
import type { AiConfig } from "../config";
import { getErrorMessage } from "../utils/tools";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 送进模型的检索片段 */
export interface AiContextChunk {
  title: string;
  url?: string;
  text: string;
  /** 索引里的页面 id（= 页面标题）；追问时用它定位同一页 */
  documentId?: string;
}

/**
 * 防幻觉用的系统提示词。
 *
 * 要求逐字保留「严格且仅根据资料回答 / 资料中未提及就直说」这两条硬约束，
 * 因为在缺氧这种数值密集的游戏里，模型一旦动用现实世界的物理直觉就会编造数值。
 */
export const SYSTEM_PROMPT = [
  "你是一个缺氧游戏助手。请【严格且仅】根据以下提供的 BWIKI 资料回答用户的问题。",
  "绝对禁止使用现实世界的物理化学知识，绝对禁止编造。",
  "如果资料中未提及，请直接回答：抱歉，资料中未提及相关信息。",
  "请用简洁、分点的中文回答。以专业玩家的口吻适当润色",
  "补充约束：",
  "1. 只能引用资料中出现的名称与数值，不得换算、不得补充资料外的机制；",
  "2. 资料中没有的信息一律视为「未提及」，不得猜测；",
  "3. 不要提及这些规则本身，也不要复述资料原文的整段内容；",
  "4. 若用户的问题是对上一轮的追问（如「它」「这个」「那它能干什么」），结合对话历史理解指代，但仍然只能使用资料中的信息。",
].join("\n");

/** 检索为空时直接使用该文案，避免无意义的模型调用 */
export const NO_ANSWER_TEXT = "抱歉，资料中未提及相关信息。";

/** 判断模型回答是否就是「资料未提及」（用于决定要不要展示来源） */
export function isNoAnswer(answer: string): boolean {
  const normalized = answer.replace(/[\s。！？!?,，、.]/g, "");
  const target = NO_ANSWER_TEXT.replace(/[\s。！？!?,，、.]/g, "");
  return normalized.length > 0 && normalized.startsWith(target);
}

/** 一轮历史问答（用于多轮追问） */
export interface AiHistoryTurn {
  question: string;
  answer: string;
}

/** 把检索片段拼成提示词里的「资料」区块 */
export function buildContext(chunks: AiContextChunk[]): string {
  return chunks
    .map((chunk, index) => {
      const source = chunk.url ? `${chunk.title}（${chunk.url}）` : chunk.title;
      return `[资料${index + 1}] 页面：${source}\n${chunk.text}`;
    })
    .join("\n\n");
}

/**
 * 组装 DeepSeek 的 messages：资料进 system，历史问答按轮次回放，用户问题进 user。
 *
 * 多轮时把之前的问答作为 `user`/`assistant` 交替插入，模型才能理解「它」指的是谁；
 * 但每轮的**资料仍然是当前检索到的那一份**，避免历史回答被当成新事实。
 */
export function buildMessages(
  question: string,
  chunks: AiContextChunk[],
  history: AiHistoryTurn[] = [],
): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `${SYSTEM_PROMPT}\n\n【BWIKI 资料开始】\n${buildContext(chunks)}\n【BWIKI 资料结束】`,
    },
  ];

  for (const turn of history) {
    if (turn.question && turn.answer) {
      messages.push({ role: "user", content: turn.question });
      messages.push({ role: "assistant", content: turn.answer });
    }
  }

  messages.push({ role: "user", content: question });
  return messages;
}

interface DeepSeekChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

/**
 * DeepSeek 对话客户端。
 *
 * 只用 `ctx.http`，不额外引入 SDK：请求体就是标准的 chat/completions，
 * 这样在 2G 小机器上少一个依赖、少一份常驻内存。
 */
export class AiService {
  constructor(
    private readonly ctx: Context,
    private readonly settings: AiConfig,
  ) {}

  get apiKey(): string {
    const configured = this.settings.deepseekApiKey?.trim();
    return configured || (process.env.DEEPSEEK_API_KEY ?? "").trim();
  }

  get enabled(): boolean {
    return Boolean(this.settings.aiEnabled && this.apiKey);
  }

  async chat(
    messages: ChatMessage[],
    options: { temperature?: number; maxTokens?: number } = {},
  ): Promise<string> {
    if (!this.settings.aiEnabled) {
      throw new Error("AI 问答未启用（aiEnabled=false）");
    }
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new Error(
        "未配置 DeepSeek API Key，请填写 deepseekApiKey 或设置环境变量 DEEPSEEK_API_KEY",
      );
    }

    const baseUrl = (
      this.settings.deepseekBaseUrl || "https://api.deepseek.com"
    ).replace(/\/+$/, "");

    let response: DeepSeekChatResponse;
    try {
      response = await this.ctx.http.post<DeepSeekChatResponse>(
        `${baseUrl}/chat/completions`,
        {
          model: this.settings.deepseekModel,
          messages,
          temperature: options.temperature ?? this.settings.aiTemperature,
          max_tokens: options.maxTokens ?? this.settings.aiMaxTokens,
          stream: false,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: this.settings.aiTimeout,
        },
      );
    } catch (error) {
      throw new Error(`调用 DeepSeek 失败：${describeHttpError(error)}`);
    }

    const content = response?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error(
        `DeepSeek 返回了空回答：${response?.error?.message ?? "未知原因"}`,
      );
    }
    return content;
  }
}

/** 尽量从 Koishi HTTP 错误里挖出可读信息，而不是只打一个 [object Object] */
function describeHttpError(error: unknown): string {
  const response = (error as { response?: { status?: number; data?: any } })
    ?.response;
  const detail =
    response?.data?.error?.message ??
    response?.data?.message ??
    (typeof response?.data === "string" ? response.data : undefined);
  if (detail) {
    return response?.status ? `HTTP ${response.status} - ${detail}` : detail;
  }
  return getErrorMessage(error);
}
