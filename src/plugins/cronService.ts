import { Context } from "koishi";
import { createCronScheduler } from "../services/cronScheduler";

/**
 * 提供 `ctx.oniCron`：插件内置的定时任务调度器。
 *
 * 必须排在 SUB_PLUGINS 最前，后面的子插件才能拿到它。
 */
export class CronService {
  public static readonly inject = [];

  constructor(ctx: Context) {
    ctx.set("oniCron", createCronScheduler(ctx));
  }
}
