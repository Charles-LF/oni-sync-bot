import { Context } from "@koishijs/client";
import Calculator from "./Rocketcalculator/calculator.vue";
import CalculatorIndex from "./Rocketcalculator/index.vue";
import SyncIndex from "./onisync/index.vue";
import SyncDashboard from "./onisync/dashboard.vue";

export default (ctx: Context) => {
  ctx.page({
    id: "home",
    name: "同步运维",
    path: "/",
    icon: "activity:home",
    order: 1000,
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

  // 覆盖内置欢迎页后需要强制重新解析一次当前路由，否则仍渲染旧组件
  ctx.on("ready", () => {
    ctx.$router.cache["home"] = "/";
    if (ctx.$router.router.currentRoute.value.fullPath === "/") {
      ctx.$router.router.replace("/");
    }
  });
};
