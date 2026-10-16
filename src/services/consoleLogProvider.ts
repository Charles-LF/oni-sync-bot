import { Context, Logger } from "koishi";
import { DataService } from "@koishijs/plugin-console";
import {} from "@koishijs/plugin-console";

declare module "@koishijs/console" {
  namespace Console {
    interface Services {
      onilogs: DataService<Logger.Record[]>;
    }
  }
}

/** 控制台日志最多保留的条数 */
const MAX_RECORDS = 1000;

/** 日志来源的命名空间 */
const LOG_SCOPE = "oni-sync";

/** 暴露给控制台的只读数据源 */
class ConsoleLogData extends DataService<Logger.Record[]> {
  constructor(
    ctx: Context,
    private readonly buffer: Logger.Record[],
  ) {
    super(ctx, "onilogs", { authority: 0 });
  }

  async get(): Promise<Logger.Record[]> {
    return this.buffer;
  }
}

export class ConsoleLogProvider {
  public static readonly inject = ["console"];

  /**
   * 日志缓冲。刻意做成实例状态而非模块级变量：
   * 模块级可变数组是全进程共享的单例，多实例或热重载时会互相串数据。
   */
  private readonly buffer: Logger.Record[] = [];

  constructor(ctx: Context) {
    ctx.plugin(ConsoleLogData, this.buffer);

    const target: Logger.Target = {
      colors: 0,
      record: (record) => {
        if (record.name !== LOG_SCOPE) return;

        this.buffer.push(record);
        // 原地裁剪，保证 ConsoleLogData 持有的数组引用始终有效
        if (this.buffer.length > MAX_RECORDS) {
          this.buffer.splice(0, this.buffer.length - MAX_RECORDS);
        }

        ctx.get("console")?.patch("onilogs", this.buffer);
      },
    };

    Logger.targets.push(target);

    ctx.on("dispose", () => {
      const index = Logger.targets.indexOf(target);
      if (index > -1) Logger.targets.splice(index, 1);
    });
  }
}
