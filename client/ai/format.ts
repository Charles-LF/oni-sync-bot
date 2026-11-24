import type { AiChatLogSummary, AiChatToolCall } from "./types";

/** AI 面板的展示格式化 */

export function userLabel(entry: { userName: string; userId: string }): string {
  return entry.userName || entry.userId || "未知用户";
}

/** 「查了什么」里单个工具调用的短标签 */
export function toolLabel(call: AiChatToolCall): string {
  const keyword = (call.keyword ?? "").trim();
  const page = (call.page ?? "").trim();
  if (keyword && page && keyword !== page) return `${keyword} → ${page}`;
  return keyword || page || call.name;
}

/** 「查了什么」一行文本，没有工具调用时说明是直接回答 */
export function toolSummary(entry: AiChatLogSummary): string {
  const calls = entry.toolCalls ?? [];
  if (calls.length === 0) return "直接回答";
  return calls.map(toolLabel).join("、");
}

/** 数字展示：过千加分隔符 */
export function formatCount(value: number): string {
  return `${value ?? 0}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
