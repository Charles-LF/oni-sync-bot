import { Time } from "@koishijs/client";

/** 跨页面共用的时间格式化，避免每个模块各写一份 */

/** `2024-05-01 08:30` */
export function formatDateTime(value?: number, fallback = "-"): string {
  if (!value) return fallback;
  return Time.template("yyyy-MM-dd hh:mm", new Date(value));
}

/** `05-01 08:30` */
export function formatShortDateTime(value?: number, fallback = "-"): string {
  if (!value) return fallback;
  return Time.template("MM-dd hh:mm", new Date(value));
}

/** `08:30:00` */
export function formatClock(value?: number, fallback = ""): string {
  if (!value) return fallback;
  return Time.template("hh:mm:ss", new Date(value));
}

/** `2024-05-01` → `05-01`（图表横轴用） */
export function formatDayTick(date: string): string {
  return date.length >= 10 ? date.slice(5) : date;
}
