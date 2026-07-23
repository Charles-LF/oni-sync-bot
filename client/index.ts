import { Context } from "@koishijs/client";
import Calculator from "./Rocketcalculator/calculator.vue";
import CalculatorIndex from "./Rocketcalculator/index.vue";
import TodoListIndex from "./onitodolist/index.vue";
import TodoList from "./onitodolist/todolist.vue";
import LogsIndex from "./onilogs/index.vue";
import Logs from "./onilogs/logs.vue";

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
