import { Context, Logger } from "koishi";
import { DataService } from "@koishijs/plugin-console";
import {} from "@koishijs/plugin-console";
import {
  LogStore,
  type OniLogFilter,
  type OniLogSnapshot,
  type OniLogSummary,
} from "./logStore";
import { getErrorMessage } from "../utils/tools";

declare module "@koishijs/console" {
  namespace Console {
    interface Services {
      /** 轻量摘要：前端监听它的变化再调用 onilogs/query 取数据 */
      onilogs: DataService<OniLogSummary>;
    }
  }

  interface Events {
    "onilogs/query"(filter?: OniLogFilter): OniLogSnapshot;
    "onilogs/clear"(): Promise<number>;
  }
}

/** 只收录本插件产生的日志 */
function isOwnLogger(name: string): boolean {
  return name === "oni-sync" || name.startsWith("oni-");
}

/** 暴露给控制台的摘要数据源（几十字节，高频推送也不心疼） */
class ConsoleLogData extends DataService<OniLogSummary> {
  constructor(
    ctx: Context,
    private readonly store: LogStore,
  ) {
    super(ctx, "onilogs", { authority: 0 });
  }

  async get(): Promise<OniLogSummary> {
    return this.store.summary();
  }
}

export class ConsoleLogProvider {
  public static readonly inject = {
    console: { required: true },
    database: { required: true },
  };

  private readonly store: LogStore;

  constructor(private readonly ctx: Context) {
    this.store = new LogStore(ctx, (summary) => {
      ctx.get("console")?.patch("onilogs", summary);
    });

    ctx.plugin(ConsoleLogData, this.store);
    void this.store.load();

    ctx.console.addListener("onilogs/query", (filter) => this.store.query(filter), {
      authority: 0,
    });
    ctx.console.addListener("onilogs/clear", () => this.store.clear(), {
      authority: 1,
    });

    const target: Logger.Target = {
      colors: 0,
      record: (record) => {
        if (!isOwnLogger(record.name)) return;
        try {
          this.store.append(record);
        } catch (error) {
          // 日志系统自身出错不能影响业务
          this.ctx
            .logger("oni-sync")
            .warn(`记录日志失败：${getErrorMessage(error)}`);
        }
      },
    };

    Logger.targets.push(target);
    ctx.on("dispose", () => {
      const index = Logger.targets.indexOf(target);
      if (index > -1) Logger.targets.splice(index, 1);
    });
  }
}
