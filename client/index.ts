import { Context } from "@koishijs/client";
import Calculator from "./Rocketcalculator/calculator.vue";
import CalculatorIndex from "./Rocketcalculator/index.vue";
import LogsIndex from "./onilogs/index.vue";
import Logs from "./onilogs/logs.vue";
import SyncIndex from "./onisync/index.vue";
import SyncDashboard from "./onisync/dashboard.vue";

export default (ctx: Context) => {
  ctx.page({
    id: "home",
    name: "同步机器人",
    path: "/",
    icon: "activity:home",
    order: 1000,
    component: LogsIndex,
    // @ts-ignore
    fields: ["onilogs"],
  });
  ctx.page({
    name: "同步运维",
    path: "/onisync",
    component: SyncIndex,
    // @ts-ignore
    fields: ["onisync"],
  });
  ctx.page({
    name: "火箭计算器",
    path: "/calculator",
    component: CalculatorIndex,
  });
  ctx.slot({
    type: "calculator",
    component: Calculator,
  });
  ctx.slot({
    type: "onisync",
    component: SyncDashboard,
  });
  ctx.slot({
    type: "onilogs",
    component: Logs,
  });

  ctx.on("ready", () => {
    ctx.$router.cache["home"] = "/";
    const currentPath = ctx.$router.router.currentRoute.value.fullPath;
    if (currentPath === "/") {
      ctx.$router.router.replace("/");
    }
  });
};
