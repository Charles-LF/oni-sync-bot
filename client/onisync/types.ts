/** 控制台前端共享的类型（与服务端事件负载保持一致） */

export type TaskState = "idle" | "running" | "paused" | "stopped";
export type TaskId = "delta" | "pages" | "images" | "modules";

export interface SyncProgress {
  phase: string;
  current: number;
  total: number;
  synced: number;
  skipped: number;
  failed: number;
  message: string;
}

export interface TaskSnapshot {
  id: TaskId;
  label: string;
  description: string;
  controllable: boolean;
  state: TaskState;
  progress: SyncProgress;
  startedAt?: number;
  finishedAt?: number;
  lastError?: string;
  lastSummary?: string;
  lastTrigger?: string;
  /** 最近一次运行 id（点开卡片时取详情） */
  lastRunId?: string;
}

export interface SyncStatus {
  tasks: TaskSnapshot[];
  activeId?: TaskId;
  version: number;
  deltaCron: string;
  nextDeltaAt?: number;
  lastSyncTime?: string;
  logCount: number;
  imageIndexCount: number;
  ignoreCount: number;
}

export interface ChangeItem {
  id: string;
  title: string;
  user: string;
  timestamp: string;
  comment: string;
  sizeDiff: number;
}

export interface ChangeDetail extends ChangeItem {
  diffHtml: string;
  revid: string;
  parentid: string;
  ns: number;
}

export interface DiffLine {
  type: "add" | "del" | "meta" | "context";
  text: string;
}

/** 一次运行（`sync_runs`） */
export interface SyncRunRow {
  id: string;
  taskId: string;
  trigger: string;
  state: "running" | "completed" | "stopped" | "failed";
  startedAt: number;
  finishedAt: number;
  message: string;
  total: number;
  synced: number;
  skipped: number;
  failed: number;
}

export interface SyncRunItemRow {
  id: string;
  runId: string;
  title: string;
  action: "synced" | "skipped" | "failed";
  reason: string;
  at: number;
}

export interface SyncRunLogRow {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
  at: number;
}

export interface SyncTaskDetail {
  run: SyncRunRow;
  items: {
    synced: SyncRunItemRow[];
    skipped: SyncRunItemRow[];
    failed: SyncRunItemRow[];
  };
  logs: SyncRunLogRow[];
}

/** `sync/log` 广播的实时日志 */
export interface SyncLogEvent {
  runId: string;
  taskId: TaskId;
  level: "info" | "warn" | "error";
  message: string;
  at: number;
  seq: number;
}

export interface IgnoreRuleView {
  id: number;
  type: "page" | "image" | "module";
  name: string;
  reason: string;
  createdAt: number;
}

/** 任务详情里切换的 Tab */
export type RunTab = "synced" | "skipped" | "failed" | "logs";
