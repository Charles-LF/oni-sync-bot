import { Logger } from "koishi";
import { Mwn } from "mwn";
import { pinyin } from "pinyin-pro";

// 常量定义
const CROSS_SITE_LINK_REGEX: RegExp = /\[\[(en|ru|pt-br):[^\]]*\]\]/g; // 跨站链接正则
const DEV_TEXT_REGEX: RegExp = /Dev:/g; // 匹配所有 Dev: 字符串的全局正则
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

/**
 * 处理文本，生成标准化的全拼和首字母
 * @param text 中文文本
 * @returns {pinyin_full: string, pinyin_first: string} 处理后的拼音信息
 */
function generatePinyinInfo(text: string): {
  pinyin_full: string;
  pinyin_first: string;
} {
  if (!text) return { pinyin_full: "", pinyin_first: "" };

  // 过滤特殊字符（保留中文、字母、数字）
  const cleanText = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "");
  if (!cleanText) return { pinyin_full: "", pinyin_first: "" };

  // 生成全拼（无音调，无分隔符，小写）
  const fullPinyin = pinyin(cleanText, {
    toneType: "none",
    type: "string",
    separator: "",
  }).toLowerCase();

  // 生成首字母缩写（小写）
  const firstLetter = pinyin(cleanText, {
    pattern: "initial",
    separator: "",
  }).toLowerCase();

  return {
    pinyin_full: fullPinyin,
    pinyin_first: firstLetter,
  };
}

const logger = new Logger("oni-sync");

export { getAndProcessPageContent, generatePinyinInfo, logger };
