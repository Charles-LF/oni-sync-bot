import { Mwn } from "mwn";
import { ISiteConfig } from "../config";
import { logger } from "./tools";

/**
 * 登录机器人
 * @param siteConfig 站点配置
 * @returns 机器人实例
 */
export async function login(siteConfig: ISiteConfig): Promise<Mwn> {
  const bot = new Mwn({
    apiUrl: siteConfig.api,
    username: siteConfig.username,
    password: siteConfig.password,
    userAgent: siteConfig.userAgent,
    defaultParams: {
      assert: "user",
    },
  });
  if (siteConfig.name === "bwiki") {
    const cookieString =
      "SESSDATA=666; Domain=wiki.biligame.com; Path=/oni; HttpOnly; Secure";
    bot.cookieJar.setCookie(cookieString, bot.options.apiUrl!, (err) => {
      if (err) console.error("Cookie 注入失败：", err);
    });
  }
  await bot.login();

  logger.info(`✅ 成功登录 ${siteConfig.name}`);
  return bot;
}
