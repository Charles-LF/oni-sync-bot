import type { RunToken } from "../../domain/sync/runToken";

/**
 * 同步任务的状态与进度类型（应用层）。
 *
 * 接口层（控制台）与基础设施层（任务管理器）都只依赖这里的类型，
 * 不再各自声明一份，避免三处字段慢慢长歪。
 */

/** 任务状态：paused 只表示「已暂停且仍在运行中」 */
export type SyncTaskState = "idle" | "running" | "paused" | "stopped";

export type SyncTaskId = "delta" | "pages" | "images" | "modules";

export interface SyncProgress {
  /** 当前阶段名，如「列举页面」「同步页面」 */
  phase: string;
  /** 当前阶段已处理条数 */
  current: number;
  /** 当前阶段总条数；0 表示未知 */
  total: number;
  synced: number;
  skipped: number;
  failed: number;
  /** 给用户看的一句话进度 */
  message: string;
}

/** 任务的静态描述 */
export interface SyncTaskMeta {
  id: SyncTaskId;
  label: string;
  description: string;
  /** false = 由代码自动调度，前端不提供开始/暂停/停止 */
  controllable: boolean;
}

export interface SyncTaskSnapshot extends SyncTaskMeta {
  state: SyncTaskState;
  progress: SyncProgress;
  startedAt?: number;
  finishedAt?: number;
  lastError?: string;
  lastSummary?: string;
  lastTrigger?: string;
  /** 最近一次运行 id（点开任务卡片时用它取详情） */
  lastRunId?: string;
}

/** 推给控制台的整块状态 */
export interface SyncPanelSnapshot {
  tasks: SyncTaskSnapshot[];
  /** 当前正在执行（或暂停中）的任务；同一时刻只有一个 */
  activeId?: SyncTaskId;
  version: number;
}

export interface SyncRunSummary {
  synced: number;
  skipped: number;
  failed: number;
  message: string;
}

/** 进度上报函数：传入要覆盖的字段 */
export type ProgressReporter = (patch: Partial<SyncProgress>) => void;

export type SyncRunner = (
  token: RunToken,
  report: ProgressReporter,
) => Promise<SyncRunSummary>;

export interface ControlResult {
  ok: boolean;
  message: string;
  status: SyncPanelSnapshot;
}

export function emptyProgress(): SyncProgress {
  return {
    phase: "空闲",
    current: 0,
    total: 0,
    synced: 0,
    skipped: 0,
    failed: 0,
    message: "",
  };
}
