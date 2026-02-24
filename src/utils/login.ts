import { Mwn } from "mwn";
import { ISiteConfig } from "../config";
import type { RawRequestParams } from "mwn/build/core";
import { Logger } from "koishi";
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

  const customRequestOptions: RawRequestParams = {
    headers: {
      "User-Agent": siteConfig.userAgent,
    },
  };

  if (siteConfig.uakey) {
    customRequestOptions.headers!["X-authkey"] = siteConfig.uakey;
  }

  bot.setRequestOptions(customRequestOptions);
  await bot.login();

  logger.info(`✅ 成功登录 ${siteConfig.name}`);
  return bot;
}
