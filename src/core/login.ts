import { Mwn } from "mwn";
import { ISiteConfig } from "../siteConfig";
import type { RawRequestParams } from "mwn/build/core";

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

  console.log(`✅ 成功登录 ${siteConfig.name}`);
  return bot;
}
