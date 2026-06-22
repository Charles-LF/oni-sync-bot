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

    ctx.server.use("/ggwiki", async (router, next) => {
      const fullPath = router.path.replace("/ggwiki", "") || "";

      // 安全校验：禁止路径遍历（先解码 URL 编码的路径，防止绕过检测）
      const decodedPath = decodeURIComponent(fullPath);
      if (decodedPath.includes("..")) {
        return (router.body = "❌ 非法路径访问！");
      }

      // 安全校验：路径只能包含合法字符（允许空路径、斜杠、中文、字母、数字、下划线、连字符、冒号、点、百分号）
      if (!/^(\/[\p{L}\p{N}_\-:.%]+)*\/?$/u.test(fullPath)) {
        return (router.body = "❌ 路径包含非法字符！");
      }

      const queryString = router.querystring ? `?${router.querystring}` : "";
      const targetUrl = `https://${this.config.main_site}${fullPath}${queryString}`;
      router.redirect(targetUrl);
      return;
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
