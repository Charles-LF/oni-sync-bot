import { Context } from "@koishijs/client";
import Calculator from "./Rocketcalculator/calculator.vue";
import CalculatorIndex from "./Rocketcalculator/index.vue";
import SyncIndex from "./onisync/index.vue";
import SyncDashboard from "./onisync/dashboard.vue";
import AiIndex from "./ai/index.vue";

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
  // AI 运营面板与「同步运维」并列：不声明 fields，页面自己拉数据，
  // 否则 store 里没有对应 key 时导航项会被禁用。
  ctx.page({
    name: "AI 运营面板",
    path: "/ai",
    icon: "paper-plane",
    order: 1001,
    component: AiIndex,
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
