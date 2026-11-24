import { Time } from "@koishijs/client";
import type { IgnoreRuleView, SyncRunRow, TaskState } from "./types";

/** 时间与尺寸的展示格式集中在这里，避免各组件各写一份 */

export function formatISO(value?: string): string {
  if (!value) return "-";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return Time.template("MM-dd hh:mm", new Date(time));
}

export function formatTime(value?: number): string {
  if (!value) return "-";
  return Time.template("yyyy-MM-dd hh:mm", new Date(value));
}

/** 日志行只显示时分秒 */
export function formatClock(value?: number): string {
  if (!value) return "";
  return Time.template("hh:mm:ss", new Date(value));
}

export function formatSize(diff: number): string {
  if (!diff) return "±0";
  return diff > 0 ? `+${diff}` : `${diff}`;
}

export function sizeClass(diff: number): string {
  if (diff > 0) return "plus";
  if (diff < 0) return "minus";
  return "zero";
}

export function stateLabel(state: TaskState): string {
  switch (state) {
    case "running":
      return "运行中";
    case "paused":
      return "已暂停";
    case "stopped":
      return "已停止";
    default:
      return "空闲";
  }
}

export function runStateLabel(state: SyncRunRow["state"]): string {
  switch (state) {
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "stopped":
      return "已停止";
    default:
      return "失败";
  }
}

export function typeLabel(type: IgnoreRuleView["type"]): string {
  if (type === "page") return "页面";
  if (type === "image") return "图片";
  return "模块";
}
