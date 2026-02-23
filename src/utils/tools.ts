import { Mwn } from "mwn";

// 常量定义
const CROSS_SITE_LINK_REGEX: RegExp = /\[\[(en|ru|pt-br):[^\]]*\]\]/g; // 跨站链接正则
const DEV_TEXT_REGEX: RegExp = /Dev:/g; // 匹配所有 Dev: 字符串的全局正则
const DEV_NAMESPACE_PREFIX = "Dev:"; // Dev命名空间前缀
const MODULE_NAMESPACE_PREFIX = "Module:Dev/"; // 目标替换前缀

/**
 * 移除跨站链接 + 替换所有 Dev: 为 Module:Dev/
 * @param text 原始页面文本
 * @returns 处理后的文本
 */
function clean_page_text(text: string): string {
  const textWithoutCrossLink = text.replace(CROSS_SITE_LINK_REGEX, "");
  const textWithReplacedDev = textWithoutCrossLink.replace(
    DEV_TEXT_REGEX,
    MODULE_NAMESPACE_PREFIX,
  );
  return textWithReplacedDev;
}

/**
 * 获取并处理页面内容
 * @param site 机器人实例
 * @param pageTitle 页面标题
 * @returns 处理后的页面内容（移除跨站链接 + 全局替换 Dev: 为 Module:Dev/）
 */
async function getAndProcessPageContent(
  site: Mwn,
  pageTitle: string,
): Promise<string> {
  try {
    const res = await site.read(pageTitle);
    const rawText = res.revisions[0]?.content || "";

    const processedText = clean_page_text(rawText);

    return processedText.trimEnd();
  } catch (err) {
    throw new Error(`[${pageTitle}] 内容获取失败: ${err}`);
  }
}

export { getAndProcessPageContent };
