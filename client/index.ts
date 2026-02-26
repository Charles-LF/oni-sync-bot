import { Context } from "@koishijs/client";
import Page from "./page.vue";

import "virtual:uno.css";

export default (ctx: Context) => {
  ctx.page({
    name: "同步机器人",
    path: "/onilogs",
    component: Page,
  });
};
