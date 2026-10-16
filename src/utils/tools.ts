import { Logger } from "koishi";
import { Mwn } from "mwn";
import { pinyin } from "pinyin-pro";

// 常量定义
const CROSS_SITE_LINK_REGEX: RegExp = /\[\[(en|ru|pt-br):[^\]]*\]\]/g; // 跨站链接正则
const DEV_TEXT_REGEX: RegExp = /(?<!\w)Dev:/g; // 匹配所有 Dev: 字符串的全局正则
const MODULE_NAMESPACE_PREFIX = "Module:Dev/"; // 目标替换前缀
const logger = new Logger("oni-sync");

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
    let rawText = "";

    try {
      const res = await site.read(pageTitle, {
        redirects: false, // 不自动跟随重定向
      });

      if (res) {
        if (typeof res === "string") {
          rawText = res;
        } else if (
          res.revisions &&
          res.revisions.length > 0 &&
          res.revisions[0].content
        ) {
          rawText = res.revisions[0].content;
        } else if (res.content) {
          rawText = res.content;
        } else if (res.wikitext) {
          rawText = res.wikitext;
        } else if (res.query && res.query.pages) {
          const pageIds = Object.keys(res.query.pages);
          if (pageIds.length > 0) {
            const page = res.query.pages[pageIds[0]];
            if (page.revisions && page.revisions.length > 0) {
              rawText = page.revisions[0].content || "";
            }
          }
        }
      }
    } catch (readErr) {
      try {
        const queryRes = await site.query({
          action: "query",
          titles: pageTitle,
          prop: "revisions",
          rvprop: "content",
          rvlimit: 1,
        });

        if (queryRes && queryRes.query && queryRes.query.pages) {
          const pages = queryRes.query.pages as Record<string, any>;
          const pageIds = Object.keys(pages);
          if (pageIds.length > 0) {
            const page = pages[pageIds[0]];
            if (page.revisions && page.revisions.length > 0) {
              rawText = page.revisions[0].content || "";
            }
          }
        }
      } catch (backupErr) {
        throw readErr;
      }
    }

    const processedText = clean_page_text(rawText);

    return processedText.trimEnd();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      `[getAndProcessPageContent] [${pageTitle}] 内容获取失败:`,
      errMsg,
    );
    throw new Error(`[${pageTitle}] 内容获取失败: ${errMsg}`);
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * 将 MediaWiki ISO 时间戳（如 "2024-06-19T10:30:45Z"）转为北京时间可读字符串。
 *
 * 实现要点：先把时间戳整体平移 +8 小时，再统一用 UTC 取值。
 * 这样结果与**运行机器的本地时区无关**，且 +8 造成的跨日/跨月/跨年进位由 Date 自动处理
 * （早期实现混用 getFullYear 与 getUTCHours，只在 UTC+8 机器上碰巧正确）。
 */
function formatWikiTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;

  const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
  const beijing = new Date(date.getTime() + BEIJING_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");

  const y = beijing.getUTCFullYear();
  const m = pad(beijing.getUTCMonth() + 1);
  const d = pad(beijing.getUTCDate());
  const hh = pad(beijing.getUTCHours());
  const mm = pad(beijing.getUTCMinutes());

  return `${y}-${m}-${d} ${hh}:${mm}`;
}

/**
 * 规范化 channelId：兼容多种前缀格式
 * @param rawId 原始 channelId
 * @returns 规范化后的 channelId
 */
function normalizeChannelId(rawId: string): string {
  const trimmed = rawId.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("group:")) return trimmed.slice(6);
  if (lower.startsWith("channel:")) return trimmed.slice(8);
  if (lower.startsWith("qq:")) return trimmed.slice(3);
  return trimmed;
}

/**
 * 截断摘要到指定长度，超出部分用 ...
 * @param text 原始文本
 * @param max 最大长度，默认为10
 * @returns 截断后的文本
 */
function truncateComment(text: string, max: number = 10): string {
  if (!text) return "";
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max) + "...";
}

/**
 * 确保图片标题以 File: 前缀开头
 * MediaWiki 的 titles 参数需要完整页面标题，否则会去主命名空间查找
 * @param fileName 文件名
 * @returns 规范化后的图片标题
 */
function normalizeImageTitle(fileName: string): string {
  const trimmed = fileName.trim();
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("file:") ||
    lower.startsWith("image:") ||
    lower.startsWith("文件:")
  ) {
    return trimmed;
  }
  return `File:${trimmed}`;
}

/**
 * 去除 File:/Image:/文件: 前缀，返回纯文件名
 * @param fileName 文件标题
 * @returns 纯文件名
 */
function stripImagePrefix(fileName: string): string {
  const trimmed = fileName.trim();
  const lower = trimmed.toLowerCase();
  const prefixes = ["file:", "image:", "文件:"];
  for (const p of prefixes) {
    if (lower.startsWith(p)) {
      return trimmed.substring(p.length);
    }
  }
  return trimmed;
}

export {
  getAndProcessPageContent,
  generatePinyinInfo,
  logger,
  getErrorMessage,
  formatWikiTime,
  normalizeChannelId,
  truncateComment,
  normalizeImageTitle,
  stripImagePrefix,
};
