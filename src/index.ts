//                   _ooOoo_
//                  o8888888o
//                  88" . "88
//                  (| o_0 |)
//                  O\  =  /O
//               ____/`---'\____
//             .'  \\|     |//  `.
//            /  \\|||  :  ||||//  \
//           /  _||||| -:- |||||-  \
//           |   | \\\  -  /// |   |
//           | \_|  ''\---/''  |   |
//           \  .-\__  `-`  ___/-. /
//         ___`. .'  /--.--\  `. . __
//      ."" '<  `.___\_<|>_/___.'  >'"".
//     | | :  `- \`.;`\ _ /`;.`/ - ` : | |
//     \  \ `-.   \_ __\ /__ _/   .-` /  /
//======`-.____`-.___\_____/___.-`____.-'======
//                   `=---='
//
//^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                  南无加特林菩萨
//          菩提本无树           明镜亦非台
//          本来无BUG            何必常修改
//                  佛曰: 能跑就行

import { Context, Schema } from "koishi";
import { resolve } from "path";
import { DataService } from "@koishijs/plugin-console";
import {} from "@koishijs/plugin-server";
import {} from "koishi-plugin-cron";
import { Mwn } from "mwn";
import { login } from "./utils/login";
import { getSitesConfig } from "./config";
import { incrementalUpdate, syncPages, syncSinglePage } from "./sync/pageSync";
import { syncModules, syncSingleModule } from "./sync/moduleSync";
import { syncAllImages, syncSingleImage } from "./sync/imgSync";
import { generatePinyinInfo } from "./utils/tools";

export const name = "oni-sync-bot";
export const inject = ["console", "database", "server", "cron"];

// 扩展数据库声明，新增拼音和首字母字段
declare module "koishi" {
  interface Tables {
    wikipages: WikiPages;
  }
}
export interface WikiPages {
  id: number;
  title: string;
  pinyin_full: string; // 全拼（无音调，无分隔符）
  pinyin_first: string; // 首字母缩写（小写）
}

export interface Config {
  ggUsername: string;
  ggPassword: string;
  huijiUsername: string;
  huijiPassword: string;
  huijiUAKey: string;
  domain: string;
  main_site: string;
  mirror_site: string;
}

export const Config: Schema<Config> = Schema.object({
  ggUsername: Schema.string()
    .description("WIKIGG 用户名")
    .default("${{ env.ggUsername }}"),
  ggPassword: Schema.string()
    .description("WIKIGG 密码")
    .default("${{ env.ggPassword }}"),
  huijiUsername: Schema.string()
    .description("灰机wiki 用户名")
    .default("${{ env.huijiUsername }}"),
  huijiPassword: Schema.string()
    .description("灰机wiki 密码")
    .default("${{ env.huijiPassword }}"),
  huijiUAKey: Schema.string()
    .description("灰机wiki UAKey")
    .default("${{ env.huijiUAKey }}"),
  domain: Schema.string()
    .description("你的短链域名（必填，如：klei.vip）")
    .default("klei.vip"),
  main_site: Schema.string()
    .description("主站域名（必填，如：oxygennotincluded.wiki.gg）")
    .default("oxygennotincluded.wiki.gg/zh"),
  mirror_site: Schema.string()
    .description("镜像站域名（必填，如：wiki.biligame.com）")
    .default("wiki.biligame.com/oni"),
});

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger("oni-sync-bot");
  let ggbot: Mwn;
  let huijibot: Mwn;
  // 注入控制台
  ctx.inject(["console"], (ctx) => {
    ctx.console.addEntry({
      dev: resolve(__dirname, "../client/index.ts"),
      prod: resolve(__dirname, "../dist"),
    });
  });

  // 扩展数据库表
  ctx.model.extend("wikipages", {
    id: "integer",
    title: "string",
    pinyin_full: "string", // 全拼
    pinyin_first: "string", // 首字母
  });
  //#region 路由重定向
  //原站路由：klei.vip/gg/[id] → 跳转至 oni.wiki/[title]?variant=zh
  ctx.server.get("/gg/:id", async (router) => {
    const pageId = Number(router.params.id);
    if (isNaN(pageId)) return (router.body = "❌ 无效的页面ID，必须为数字！");

    const [page] = await ctx.database.get("wikipages", { id: pageId });
    if (!page)
      return (router.body = `❌ 未找到ID为【${pageId}】的页面，请联系管理员更新缓存！`);
    const targetUrl = `https://${config.main_site}/${encodeURIComponent(
      page.title,
    )}?variant=zh`;
    router.redirect(targetUrl); //重定向至oxygennotincluded.wiki.gg
  });

  // 镜像站路由：klei.vip/bw/[id] → 跳转至 wiki.biligame.com/oni/[title]
  ctx.server.get("/bw/:id", async (router) => {
    const pageId = Number(router.params.id);
    if (isNaN(pageId)) return (router.body = "❌ 无效的页面ID，必须为数字！");

    const [page] = await ctx.database.get("wikipages", { id: pageId });
    if (!page)
      return (router.body = `❌ 未找到ID为【${pageId}】的页面，请联系管理员更新缓存！`);

    const targetUrl = `https://${config.mirror_site}/${encodeURIComponent(
      page.title,
    )}`;
    router.redirect(targetUrl); //重定向至wiki.biligame.com
  });
  //#endregion

  // 插件准备就绪后登录两个账号并且初始化定时任务
  ctx.on("ready", async () => {
    logger.info("初始化中...");
    const sitesConfig = getSitesConfig(config);
    ggbot = await login(sitesConfig.gg);
    huijibot = await login(sitesConfig.huiji);
    if (ggbot.login && huijibot.login) {
      logger.info("登录成功，插件已准备就绪");
    } else {
      logger.error("登录失败，请检查配置");
    }
    //#region 自动任务：每小时获取原站三小时的最近编辑并尝试同步
    ctx.cron("15 * * * *", async () => {
      await incrementalUpdate(ggbot, huijibot, config);
    });
    //#endregion

    //#region 自动任务：每周四8:30同步所有页面
    ctx.cron("30 8 * * 4", async () => {
      await syncPages(ggbot, huijibot)
        .then(() => {
          logger.info("自动任务：尝试同步所有页面，从 WIKIGG 到 灰机wiki");
        })
        .catch((err) => {
          logger.error(`同步所有页面失败，错误信息：${err}`);
        });
    });
    //#endregion
    //#region 自动任务：每周三8:30同步所有图片
    ctx.cron("30 8 * * 3", async () => {
      await syncAllImages(ggbot, huijibot, config)
        .then(() => {
          logger.info("自动任务：尝试同步所有图片，从 WIKIGG 到 灰机wiki");
        })
        .catch((err) => {
          logger.error(`同步所有图片失败，错误信息：${err}`);
        });
    });
    //#endregion
  });

  // 指令
  //#region 指令：同步单个页面指令
  ctx
    .command("sync <pageTitle:string>", "同步指定页面", { authority: 2 })
    .action(async ({ session }, pageTitle) => {
      await syncSinglePage(ggbot, huijibot, pageTitle, "sync-bot")
        .then(() => {
          session.send(
            `✅ 已尝试同步页面：${pageTitle}，从 WIKIGG 到 灰机wiki`,
          );
        })
        .catch((err) => {
          session.send(`❌ 同步页面失败：${pageTitle}，错误信息：${err}`);
        });
    });
  // #endregion

  // #region 指令：增量更新
  ctx
    .command("sync.incrementalUpdate", "同步所有页面", { authority: 2 })
    .alias("增量更新")
    .action(async ({ session }) => {
      session.send(`🚀 开始同步所有页面，任务耗时可能较长，请耐心等待...`);
      await incrementalUpdate(ggbot, huijibot, config)
        .then(() => {
          session.send(
            `✅ 已尝试获取三小时前的编辑并同步，从 WIKIGG 到 灰机wiki`,
          );
        })
        .catch((err) => {
          session.send(`❌ 同步所有页面失败，错误信息：${err}`);
        });
    });
  // #endregion

  //#region 指令：同步所有页面
  ctx
    .command("sync.allpages", "同步所有页面", { authority: 2 })
    .action(async ({ session }) => {
      session.send(`🚀 开始同步所有页面，任务耗时较长，请耐心等待...`);
      await syncPages(ggbot, huijibot)
        .then(() => {
          session.send(`✅ 已尝试同步所有页面，从 WIKIGG 到 灰机wiki`);
        })
        .catch((err) => {
          session.send(`❌ 同步所有页面失败，错误信息：${err}`);
        });
    });
  // #endregion

  //#region 指令：同步单个模块
  ctx
    .command("sync.module <moduleTitle:string>", "同步指定模块", {
      authority: 2,
    })
    .action(async ({ session }, moduleTitle) => {
      await syncSingleModule(ggbot, huijibot, moduleTitle, "sync-bot")
        .then(() => {
          session.send(
            `✅ 已尝试同步模块：${moduleTitle}，从 WIKIGG 到 灰机wiki`,
          );
        })
        .catch((err) => {
          session.send(`❌ 同步模块失败：${moduleTitle}，错误信息：${err}`);
        });
    });
  // #endregion

  //#region 指令：同步所有模块
  ctx
    .command("sync.allmodules", "同步所有模块", { authority: 2 })
    .action(async ({ session }) => {
      session.send(`🚀 开始同步所有模块，任务耗时较长，请耐心等待...`);
      await syncModules(ggbot, huijibot)
        .then(() => {
          session.send(`✅ 已尝试同步所有模块，从 WIKIGG 到 灰机wiki`);
        })
        .catch((err) => {
          session.send(`❌ 同步所有模块失败，错误信息：${err}`);
        });
    });
  // #endregion

  // #region 指令：同步单个图片
  ctx
    .command("sync.img <imgTitle:string>", "同步指定图片", { authority: 2 })
    .action(async ({ session }, imgTitle) => {
      await syncSingleImage(
        ggbot,
        huijibot,
        `${imgTitle.startsWith("File:") ? "" : "File:"}${imgTitle}`,
        config,
      )
        .then(() => {
          session.send(`✅ 已尝试同步图片：${imgTitle}`);
        })
        .catch((err) => {
          session.send(`❌ 同步图片失败：${imgTitle}，错误信息：${err}`);
        });
    });
  //#endregion

  // #region 指令：同步所有图片
  ctx
    .command("sync.allimgs", "同步所有图片", { authority: 2 })
    .action(async ({ session }) => {
      session.send(`🚀 开始同步所有图片，任务耗时较长，请耐心等待...`);
      await syncAllImages(ggbot, huijibot, config)
        .then(() => {
          session.send(`✅ 已尝试同步所有图片，从 WIKIGG 到 灰机wiki`);
        })
        .catch((err) => {
          session.send(`❌ 同步所有图片失败，错误信息：${err}`);
        });
    });
  // #endregion

  // #region 指令：查wiki"
  ctx
    .command("x <itemName>", "查询缺氧中文wiki，精准匹配+拼音模糊匹配")
    .alias("/查wiki")
    .action(async ({ session }, itemName = "") => {
      const queryKey = itemName.trim().toLowerCase();
      // 空关键词返回使用说明，不进行查询，需要手动输入数据库ID 8个8
      if (queryKey === "")
        return `以下是使用说明：\n原站点: https://${config.domain}/gg/88888888\n\n镜像站: https://${config.domain}/bw/88888888`;

      // 将用户输入的关键词转换为拼音/首字母
      const { pinyin_full: queryPinyinFull, pinyin_first: queryPinyinFirst } =
        generatePinyinInfo(queryKey);

      // 精准匹配标题
      const preciseTitleRes = await ctx.database.get("wikipages", {
        title: queryKey,
      });
      if (preciseTitleRes.length > 0) {
        const { id } = preciseTitleRes[0];
        return `✅ 精准匹配成功\n原站点: https://${config.domain}/gg/${id}\n\n镜像站: https://${config.domain}/bw/${id}`;
      }

      // 匹配全拼
      const preciseFullPinyinRes = await ctx.database.get("wikipages", {
        pinyin_full: queryKey,
      });
      if (preciseFullPinyinRes.length > 0) {
        const { id, title } = preciseFullPinyinRes[0];
        return `✅ 拼音精准匹配成功（${queryKey} → ${title}）\n原站点: https://${config.domain}/gg/${id}\n\n镜像站: https://${config.domain}/bw/${id}`;
      }

      // 匹配首字母
      const preciseFirstPinyinRes = await ctx.database.get("wikipages", {
        pinyin_first: queryKey,
      });
      if (preciseFirstPinyinRes.length > 0) {
        const { id, title } = preciseFirstPinyinRes[0];
        return `✅ 首字母精准匹配成功（${queryKey} → ${title}）\n原站点: https://${config.domain}/gg/${id}\n\n镜像站: https://${config.domain}/bw/${id}`;
      }

      // 模糊匹配（标题/全拼/首字母包含关键词）
      const allPages = await ctx.database.get("wikipages", {});
      if (allPages.length === 0) {
        return `❌ 本地缓存为空，请联系管理员执行【update】指令更新缓存！`;
      }

      const matchResult: Array<{ id: number; title: string; score: number }> =
        [];

      allPages.forEach((page) => {
        const { title, pinyin_full, pinyin_first } = page;
        let score = 0;

        // 标题包含关键词（最高权重）
        if (title.includes(queryKey)) score += 10;
        // 标题拼音前缀匹配用户输入关键词的拼音（次高权重）
        if (pinyin_full.startsWith(queryPinyinFull)) score += 9;
        // 标题拼音包含用户输入关键词的拼音
        if (pinyin_full.includes(queryPinyinFull)) score += 8;
        // 标题首字母包含用户输入关键词的首字母
        if (pinyin_first.includes(queryPinyinFirst)) score += 6;
        // 用户输入关键词的拼音包含标题拼音的前缀（兜底）
        if (
          queryPinyinFull.includes(
            pinyin_full.substring(
              0,
              Math.min(pinyin_full.length, queryPinyinFull.length),
            ),
          )
        )
          score += 5;

        if (score > 0) {
          matchResult.push({ id: page.id, title, score });
        }
      });

      if (matchResult.length === 0) {
        return `❌ 未找到【${queryKey}】相关内容，请按游戏内标准名称重新查询！`;
      }

      // 排序：分数降序 → 标题长度升序
      const sortedResult = matchResult.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.title.length - b.title.length;
      });

      // 去重 + 取前5条
      const uniqueResult = Array.from(
        new Map(sortedResult.map((item) => [item.title, item])).values(),
      ).slice(0, 5);
      const resultCount = uniqueResult.length;

      let replyMsg = `🔍 未找到精准匹配，为你找到【 ${resultCount} 】个相似结果，请输入序号选择（10秒内有效）：\n`;
      uniqueResult.forEach((item, index) => {
        replyMsg += `${index + 1}. ${item.title}\n`;
      });
      replyMsg += `\n❗️ 提示：超时将静默结束，无任何回应`;
      await session.send(replyMsg);

      // 等待用户输入
      const userInput = await session.prompt(15000);
      if (!userInput) return;

      const selectNum = parseInt(userInput.trim());
      if (isNaN(selectNum) || selectNum < 1 || selectNum > resultCount) {
        return `❌ 输入无效！请输入 1-${resultCount} 之间的数字序号`;
      }

      const { id } = uniqueResult[selectNum - 1];
      return `✅ 选择成功\n原站点: https://${config.domain}/gg/${id}\n\n镜像站: https://${config.domain}/bw/${id}`;
    });
  // #endregion

  // #region 指令：更新本地页面缓存
  ctx
    .command("update", "更新本地页面缓存（主站）", { authority: 2 })
    .action(async ({ session }) => {
      await session.execute("update.status");
      try {
        const res = await ggbot.request({
          action: "query",
          list: "allpages",
          format: "json",
          aplimit: "max",
        });
        logger.info("主站页面查询成功");
        const pages = res.query.allpages || [];

        // 批量处理页面数据，生成拼音信息
        const pageData = pages.map((page) => {
          const { pinyin_full, pinyin_first } = generatePinyinInfo(page.title);
          return {
            id: page.pageid,
            title: page.title,
            pinyin_full,
            pinyin_first,
          };
        });

        // 批量更新数据库
        if (pageData.length > 0) {
          await ctx.database.upsert("wikipages", pageData);
        }

        session.send(`✅ 检索到 ${pages.length} 个页面，已更新至数据库`);
        logger.info(`检索到 ${pages.length} 个页面，已更新至数据库`);
      } catch (err) {
        logger.error("主站缓存更新失败", err);
        session.send("❌ 主站缓存更新失败，请联系管理员查看日志");
      }
    });
  // #endregion

  // #region 指令：删除本地缓存
  ctx
    .command("update.delete", "删除本地页面缓存", { authority: 4 })
    .action(async ({ session }) => {
      try {
        const count = await ctx.database.remove("wikipages", {});
        session.send(`✅ 已删除 ${count.removed} 条本地缓存`);
        logger.info(`已删除 ${count.removed} 条本地缓存`);
      } catch (err) {
        logger.error("删除缓存失败", err);
        session.send("❌ 删除缓存失败，请联系管理员查看日志");
      }
    });
  // #endregion

  // #region 指令：查询缓存状态
  ctx
    .command("update.status", "查询本地缓存数量", { authority: 1 })
    .action(async ({ session }) => {
      try {
        const pages = await ctx.database.get("wikipages", {});
        session.send(`📊 数据库中缓存了 ${pages.length} 条页面`);
        logger.info(`数据库中缓存了 ${pages.length} 条页面`);
      } catch (err) {
        logger.error("查询缓存状态失败", err);
        session.send("❌ 查询缓存状态失败，请联系管理员查看日志");
      }
    });
  // #endregion

  // #region 指令：添加重定向
  ctx
    .command("redirect <pageName> <targetPageName>", "添加原站点重定向", {
      authority: 2,
    })
    .alias("重定向")
    .action(async ({ session }, pageName, targetPageName) => {
      if (!pageName || !targetPageName) {
        return "❌ 参数错误！用法：redirect <原页面名> <目标页面名>";
      }
      try {
        await ggbot.create(
          pageName,
          `#REDIRECT [[${targetPageName}]]`,
          "来自qq机器人的添加重定向页面请求",
        );
        logger.info(`已为 ${pageName} 添加重定向至 ${targetPageName}`);
        session.send(`✅ 已尝试添加重定向 ${pageName} -> ${targetPageName}`);
        // 更新缓存
        await session.execute(`update`);
      } catch (err) {
        logger.error(`添加重定向 ${pageName} -> ${targetPageName} 失败`, err);
        session.send(`❌ 添加重定向失败，请联系管理员查看日志`);
      }
    });
  // #endregion
}
