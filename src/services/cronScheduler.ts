import { Context } from "koishi";
import { getErrorMessage, logger } from "../utils/tools";
import { nextCronTime, parseCron, type CronSchedule } from "../utils/cron";

/** 定时任务回调：抛错只记日志，不影响后续调度 */
export type CronTask = () => unknown | Promise<unknown>;

export interface CronJobInfo {
  id: string;
  name: string;
  expression: string;
  /** 下次触发时间（没有可触发时间时为 undefined） */
  next?: Date;
}

export interface CronScheduler {
  /** 注册定时任务，返回 id；表达式非法时返回空串 */
  (expression: string, task: CronTask, name?: string): string;
  cancel(id: string): void;
  list(): CronJobInfo[];
}

declare module "koishi" {
  interface Context {
    /** 内置 cron 调度器（见 plugins/cronService.ts），不依赖 koishi-plugin-cron */
    oniCron: CronScheduler;
  }
}

/** setTimeout 的安全上限（约 24.8 天），超长间隔分段等待 */
const MAX_DELAY = 2 ** 31 - 1;

interface JobState {
  info: CronJobInfo;
  schedule: CronSchedule;
  task: CronTask;
  timer?: () => void;
  running: boolean;
  cancelled: boolean;
}

/**
 * 创建挂在 `ctx` 上的 cron 调度器。
 *
 * 用 `ctx.setTimeout` 排期：插件卸载时定时器会随之清空，不需要手工 dispose。
 * 同一任务串行执行（上次未结束则本次跳过），异常只记日志。
 */
export function createCronScheduler(ctx: Context): CronScheduler {
  const jobs = new Map<string, JobState>();
  let seq = 0;

  const scheduleNext = (id: string): void => {
    const job = jobs.get(id);
    if (!job || job.cancelled) return;

    const next = nextCronTime(job.schedule, new Date());
    if (!next) {
      logger.warn(
        `定时任务「${job.info.name}」的表达式 ${job.info.expression} 未来 4 年内不会触发，已停用`,
      );
      return;
    }
    job.info.next = next;

    const delay = Math.max(0, next.getTime() - Date.now());
    job.timer = ctx.setTimeout(
      () => {
        if (delay > MAX_DELAY) {
          // 间隔太长，先醒来重算一次
          scheduleNext(id);
          return;
        }
        void fire(id);
      },
      Math.min(delay, MAX_DELAY),
    );
  };

  const fire = async (id: string): Promise<void> => {
    const job = jobs.get(id);
    if (!job || job.cancelled) return;

    job.timer = undefined;
    if (job.running) {
      logger.warn(`定时任务「${job.info.name}」上一次还没跑完，本次跳过`);
    } else {
      job.running = true;
      try {
        await job.task();
      } catch (error) {
        logger.error(
          `定时任务「${job.info.name}」执行失败：${getErrorMessage(error)}`,
        );
      } finally {
        job.running = false;
      }
    }
    scheduleNext(id);
  };

  const register = ((
    expression: string,
    task: CronTask,
    name?: string,
  ): string => {
    let schedule: CronSchedule;
    try {
      schedule = parseCron(expression);
    } catch (error) {
      logger.error(
        `定时任务表达式无效「${expression}」：${getErrorMessage(error)}，已跳过`,
      );
      return "";
    }

    const id = `oni-cron-${++seq}`;
    jobs.set(id, {
      info: { id, name: name ?? expression, expression: schedule.expression },
      schedule,
      task,
      running: false,
      cancelled: false,
    });
    logger.debug(`已注册定时任务「${name ?? expression}」（${expression}）`);
    scheduleNext(id);
    return id;
  }) as CronScheduler;

  register.cancel = (id: string) => {
    const job = jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    job.timer?.();
    jobs.delete(id);
  };

  register.list = () =>
    [...jobs.values()].map((job) => ({ ...job.info }));

  return register;
}
