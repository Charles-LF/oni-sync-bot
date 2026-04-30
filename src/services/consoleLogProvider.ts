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

let logBuffer: Logger.Record[] = [];

class PublicLogProvider extends DataService<Logger.Record[]> {
  constructor(ctx: Context) {
    super(ctx, "onilogs", { authority: 0 });
  }
  async get() {
    return logBuffer;
  }
}

export class ConsoleLogProvider {
  public static readonly inject = ["console"];

  constructor(ctx: Context) {
    ctx.plugin(PublicLogProvider);

    const target: Logger.Target = {
      colors: 0,
      record: (record) => {
        if (record.name !== "oni-sync") return;

        logBuffer.push(record);
        if (logBuffer.length > 1000) {
          logBuffer = logBuffer.slice(-1000);
        }

        ctx.get("console")?.patch("onilogs", logBuffer);
      },
    };

    Logger.targets.push(target);

    ctx.on("dispose", () => {
      const index = Logger.targets.indexOf(target);
      if (index > -1) Logger.targets.splice(index, 1);
    });
  }
}

export function apply(ctx: Context) {
  ctx.plugin(ConsoleLogProvider);
}
