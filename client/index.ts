import { Context } from "@koishijs/client";
import Page from "./page.vue";
import Calculator from "./Rocketcalculator/calculator.vue";
import CalculatorIndex from "./Rocketcalculator/index.vue";
import TodoListIndex from "./onitodolist/index.vue";
import TodoList from "./onitodolist/todolist.vue";

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
    component: CalculatorIndex,
  });
  ctx.page({
    name: "缺氧 TodoList",
    path: "/onitodos",
    component: TodoListIndex,
  });
  ctx.slot({
    type: "calculator",
    component: Calculator,
  });
  ctx.slot({
    type: "onitodos",
    component: TodoList,
  });
};
