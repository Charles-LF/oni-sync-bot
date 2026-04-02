import { Context, Schema } from "koishi";
import {} from "@koishijs/plugin-server";

export interface RouteRedirectConfig {
  domain: string;
  main_site: string;
  bwiki_site: string;
}

export class RouteRedirect {
  public static readonly inject = ["database", "server"];
  public config: RouteRedirectConfig;

  constructor(ctx: Context, config: RouteRedirectConfig) {
    this.config = config;

    ctx.server.get("/gg/:id", async (router) => {
      const pageId = Number(router.params.id);
      if (isNaN(pageId)) return (router.body = "❌ 无效的页面ID，必须为数字！");

      const [page] = await ctx.database.get("wikipages", { id: pageId });
      if (!page)
        return (router.body = `❌ 未找到ID为【${pageId}】的页面，请联系管理员更新缓存！`);
      const targetUrl = `https://${this.config.main_site}/${encodeURIComponent(
        page.title,
      )}?variant=zh`;
      router.redirect(targetUrl);
    });

    ctx.server.get("/bw/:id", async (router) => {
      const pageId = Number(router.params.id);
      if (isNaN(pageId)) return (router.body = "❌ 无效的页面ID，必须为数字！");

      const [page] = await ctx.database.get("wikipages", { id: pageId });
      if (!page)
        return (router.body = `❌ 未找到ID为【${pageId}】的页面，请联系管理员更新缓存！`);

      const targetUrl = `https://${this.config.bwiki_site}/${encodeURIComponent(
        page.title,
      )}`;
      router.redirect(targetUrl);
    });
  }
}

export namespace RouteRedirect {
  export const Config: Schema<RouteRedirectConfig> = Schema.object({
    domain: Schema.string()
      .description("你的短链域名（必填，如：klei.vip）")
      .default("klei.vip"),
    main_site: Schema.string()
      .description("主站域名（必填，如：oxygennotincluded.wiki.gg）")
      .default("oxygennotincluded.wiki.gg/zh"),
    bwiki_site: Schema.string()
      .description("镜像站域名（必填，如：wiki.biligame.com）")
      .default("wiki.biligame.com/oni"),
  });
}

export function apply(ctx: Context, config: RouteRedirectConfig) {
  ctx.plugin(RouteRedirect, config);
}
