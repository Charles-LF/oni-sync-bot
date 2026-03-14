import { Context } from "@koishijs/client";
import Page from "./page.vue";
import Calculator from "./Rocketcalculator/calculator.vue";
import index from "./Rocketcalculator/index.vue";

export default (ctx: Context) => {
  ctx.page({
    name: "同步机器人",
    path: "/onilogs",
    component: Page,
    // @ts-ignore
    fields: ["onilogs"],
  });
  ctx.page({
    name: "火箭计算器",
    path: "/calculator",
    component: index,
  });
  ctx.slot({
    type: "calculator",
    component: Calculator,
  });
};
