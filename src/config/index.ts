import { Config } from "../index";

// 站点配置
const userAgent = `OniSyncBot/1.0 (https://klei.vip; Charles@klei.vip)`;
export interface ISiteConfig {
  name: string; // 站点名称
  api: string; // 站点 API 地址
  username: string; // 站点用户名
  password: string; // 站点密码
  userAgent: string; // 站点 User-Agent
}

interface ISitesConfig {
  gg: ISiteConfig;
  bwiki: ISiteConfig;
}

export function getSitesConfig(config: Config): ISitesConfig {
  return {
    gg: {
      name: "WIKIGG",
      api: "https://oxygennotincluded.wiki.gg/zh/api.php",
      username: config.ggUsername,
      password: config.ggPassword,
      userAgent: userAgent,
    },
    bwiki: {
      name: "bwiki",
      api: "https://wiki.biligame.com/oni/api.php",
      username: config.bwikiusername,
      password: config.bwikipassword,
      userAgent: userAgent,
    },
  };
}
