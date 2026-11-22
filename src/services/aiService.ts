import { Context } from "koishi";
import type { AiConfig } from "../config";
import { getErrorMessage } from "../utils/tools";

/** DeepSeek 对话客户端（Function Calling）。只用 ctx.http，不引 SDK */

/** 第 1 轮提示词：先查资料再回答 */
export const AGENT_SYSTEM_PROMPT = [
  "你是一个缺氧（Oxygen Not Included）游戏助手，可以使用 search_oni_bwiki 工具检索缺氧中文 BWIKI。",
  "规则：",
  "1. 只要问题涉及游戏内容（建筑、元素、植物、生物、物品、机制、数值、配方、技巧），**必须先调用工具**检索，不得凭记忆作答；",
  "2. 绝对禁止使用现实世界的物理化学知识，绝对禁止编造数值；",
  "3. 关键词尽量用游戏内标准中文名（如「电解器」「氧石精炼炉」），不要带「怎么」「多少」这类问句成分；",
  "4. 一次最多检索 2 个关键词（比如比较两个建筑时）；",
  "5. 对话历史**只**用于解析没有主语的指代：问题里出现「它」「这个」「那它…」或明显省略了主语时，才用历史补出词条；",
  "6. 当前问题里出现了新的游戏词条（哪怕和上一轮毫无关系），就必须按**当前问题的词条**检索，严禁把历史里的词条当成检索对象；",
  "7. 当前问题与上一轮话题无关时，直接忽略历史，按新问题独立检索。",
].join("\n");

/** 第 2 轮提示词：资料是唯一事实来源（防幻觉硬约束） */
export const ANSWER_SYSTEM_PROMPT = [
  "你是一个缺氧游戏助手。请【严格且仅】根据以下提供的 BWIKI 资料回答用户的问题。",
  "绝对禁止使用现实世界的物理化学知识，绝对禁止编造。",
  "如果资料中未提及，请直接回答：抱歉，资料中未提及相关信息。",
  "请用简洁、分点的中文回答。以专业玩家的口吻适当润色",
  "补充约束：",
  "1. 只能引用资料中出现的名称与数值，不得换算、不得补充资料外的机制；",
  "2. 资料中没有的信息一律视为「未提及」，不得猜测；",
  "3. 不要提及这些规则本身，也不要复述资料原文的整段内容；",
  "4. 若用户的问题是对上一轮的追问（如「它」「这个」「那它能干什么」），结合对话历史理解指代，但仍然只能使用资料中的信息；",
  "5. 资料讲的是另一个词条、并没有覆盖当前问题所问的对象时，直接回答未提及，严禁拿 A 的资料去回答关于 B 的问题。",
].join("\n");

/** 资料为空时直接回该文案，省一次模型调用 */
export const NO_ANSWER_TEXT = "抱歉，资料中未提及相关信息。";

/** 回答是否为「未提及」（决定要不要展示来源） */
export function isNoAnswer(answer: string): boolean {
  const normalized = answer.replace(/[\s。！？!?,，、.]/g, "");
  const target = NO_ANSWER_TEXT.replace(/[\s。！？!?,，、.]/g, "");
  return normalized.length > 0 && normalized.startsWith(target);
}

/** OpenAI 兼容的 tool 定义 */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 原始 tool_call，`arguments` 是 JSON 字符串（必须原样回传） */
export interface RawToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

/** 送给 DeepSeek 的消息：每个 tool_call 都必须配一条 tool 回复，否则 400 */
export type AgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: RawToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** 参数已从 JSON 字符串解开的工具调用 */
export interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  raw: RawToolCall;
}

/** 一次 chat/completions 的结果 */
export interface CompletionResult {
  content: string;
  toolCalls: ParsedToolCall[];
  /** 原样 assistant 消息，第 2 轮要原封不动塞回 messages */
  message: Extract<AgentMessage, { role: "assistant" }>;
}

interface DeepSeekChatResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: RawToolCall[];
    };
  }>;
  error?: { message?: string };
}

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

  /** 调一次 chat/completions；`toolChoice:'required'` 可逼模型必须检索 */
  async complete(
    messages: AgentMessage[],
    options: {
      tools?: ToolDefinition[];
      toolChoice?: ToolChoice;
      temperature?: number;
      maxTokens?: number;
    } = {},
  ): Promise<CompletionResult> {
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

    const body: Record<string, unknown> = {
      model: this.settings.deepseekModel,
      messages,
      temperature: options.temperature ?? this.settings.aiTemperature,
      max_tokens: options.maxTokens ?? this.settings.aiMaxTokens,
      stream: false,
    };
    if (options.tools?.length) {
      body.tools = options.tools;
      if (options.toolChoice) body.tool_choice = options.toolChoice;
    }

    let response: DeepSeekChatResponse;
    try {
      response = await this.ctx.http.post<DeepSeekChatResponse>(
        `${baseUrl}/chat/completions`,
        body,
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

    const choice = response?.choices?.[0]?.message;
    if (!choice) {
      throw new Error(
        `DeepSeek 返回了空响应：${response?.error?.message ?? "未知原因"}`,
      );
    }

    const rawCalls = choice.tool_calls ?? [];
    const message: Extract<AgentMessage, { role: "assistant" }> = {
      role: "assistant",
      // 用空串而不是 null：只有「带 tool_calls」的 assistant 消息才允许 content 为 null
      content: choice.content ?? "",
    };
    if (rawCalls.length > 0) message.tool_calls = rawCalls;

    return {
      content: (choice.content ?? "").trim(),
      toolCalls: rawCalls.map(parseToolCall),
      message,
    };
  }
}

/** 解析 arguments，失败时给空参数（由调用方判定关键词缺失） */
function parseToolCall(call: RawToolCall): ParsedToolCall {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.function?.arguments || "{}");
    if (parsed && typeof parsed === "object") {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    args = {};
  }
  return {
    id: call.id,
    name: call.function?.name ?? "",
    args,
    raw: call,
  };
}

/** 从 HTTP 错误里挖出可读信息，别只打 [object Object] */
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
