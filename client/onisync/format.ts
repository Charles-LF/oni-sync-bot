import { formatShortDateTime } from "../shared/time";
import type { IgnoreRuleView, SyncRunRow, TaskState } from "./types";

/** 同步运维专用格式化；时间相关的基础函数统一放在 `shared/time.ts` */

export { formatClock, formatDateTime as formatTime } from "../shared/time";

export function formatISO(value?: string): string {
  if (!value) return "-";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return formatShortDateTime(time);
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
