import { load } from "cheerio";

/**
 * HTML → 纯文本。
 *
 * 这里只放**纯函数**：不依赖 Koishi Context、不发请求，因此可以被单元测试直接覆盖
 * （见 tests/renderText.spec.ts）。
 *
 * 输入是 MediaWiki `action=parse&prop=text` 的渲染结果（模板、模块已展开），
 * 由 `WikiBotService.fetchPagePlainText` 调用。
 *
 * 表格策略（针对 bwiki 的实际结构）：
 * - **信息框 `.infobox` 必须保留**：耗电、温度、尺寸、建筑血量这些数值只在信息框里，
 *   直接删掉等于把答案删了。这里把它抽成 `标签：值` 的文本行；
 * - 正文数据表压平成 `单元格 | 单元格` 的行；
 * - 导航框 / 目录 / 脚本 / 脚注标记等确实的噪音才丢弃；
 * - 想完全按「剔除所有表格」处理时把 `tableMode` 设为 `"drop"`。
 */

export type TableMode = "flatten" | "drop";

export interface ExtractTextOptions {
  /** 表格处理方式，默认 `"flatten"`（压平保留数值） */
  tableMode?: TableMode;
  /** 最大保留字数，0 或省略表示不限制 */
  maxLength?: number;
}

/** 一律丢弃的元素：脚本、样式、编辑链接、导航框、目录、脚注标记等（信息框要保留！） */
const NOISE_SELECTOR = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "form",
  "audio",
  "video",
  ".mw-editsection",
  ".mw-jump-link",
  ".printfooter",
  ".catlinks",
  ".navbox",
  ".navbox-inner",
  ".vertical-navbox",
  ".sidebar",
  ".toc",
  "#toc",
  ".metadata",
  ".ambox",
  ".noprint",
  ".reference",
  ".mw-collapsible-toggle",
  ".mw-empty-elt",
].join(",");

/** 即使在 flatten 模式下也要丢弃的表格（导航类，不含信息框） */
const NOISE_TABLE_SELECTOR = [
  ".navbox",
  ".vertical-navbox",
  ".sidebar",
  ".metadata",
  ".ambox",
].join(",");

/** 视为一个内容块的标签，按文档顺序输出 */
const BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,dt,dd,blockquote,pre";

/**
 * 把信息框抽成「标签：值」的文本行。
 *
 * bwiki 的建筑信息框实际结构是：外层 `table.infobox`，里面既有
 * `th.infobox-th + td.infobox-td` 的普通键值行（ID / 尺寸 / 建筑血量…），
 * 也有嵌套的 `table.infobox-group`（效果 / 数据…），其单元格里是
 * `div.infobox-group-child`（`div.infobox-th` 标签 + `div.infobox-td` 值）。
 * 这些数值（耗电、产热、材料）正是 AI 最需要的东西，必须完整保留。
 */
function flattenInfobox(
  $: ReturnType<typeof load>,
  box: ReturnType<ReturnType<typeof load>>,
): string[] {
  const lines: string[] = [];
  // 「折叠 / 展开」按钮是纯噪音
  box.find(".mw-collapsible-toggle").remove();
  // 「不同材料」的装饰/导热变体是默认折叠的次要数据，逐材料罗列会挤占检索块
  box.find(".infobox-material-grid").remove();

  const title = squashInline(box.find(".infobox-title").first().text());
  if (title) lines.push(`【${title}】`);

  // 信息框顶部的简介与图注
  box.find(".infobox-caption, .infobox-data-full").each((_, node) => {
    const text = squashInline($(node).text());
    if (text && text !== title) lines.push(text);
  });

  // 分组卡片：效果 / 数据 …
  box.find(".infobox-group").each((_, group) => {
    const groupNode = $(group);
    const groupTitle = squashInline(
      groupNode.find(".infobox-group-title").first().text(),
    );
    const children: string[] = [];
    groupNode.find(".infobox-group-child").each((__, child) => {
      const childNode = $(child);
      const label = squashInline(childNode.find(".infobox-th").first().text());
      const value = squashInline(childNode.find(".infobox-td").first().text());
      if (value) children.push(label ? `${label}：${value}` : value);
    });

    if (children.length > 0) {
      lines.push(groupTitle ? `[${groupTitle}]` : "", ...children);
    }
  });

  // 普通键值行（跳过已处理的标题行、图注行与分组行）
  box.find("tr").each((_, tr) => {
    const row = $(tr);
    // 分组表格内部的行已经由上面的 .infobox-group 分支产出，这里跳过避免重复
    if (row.parents(".infobox-group").length) return;
    if (row.find(".infobox-group, .infobox-group-child").length) return;

    const label = squashInline(row.children("th").not(".infobox-title").text());
    const values = row
      .children("td")
      .filter(
        (__, td) =>
          !$(td).is(
            ".infobox-image-cell, .infobox-data-full, .infobox-group-cell",
          ),
      )
      .toArray()
      .map((td) => squashInline($(td).text()))
      .filter(Boolean);

    if (label && values.length) {
      for (const value of values) lines.push(`${label}：${value}`);
    } else if (label && label.length <= 12) {
      lines.push(label);
    } else if (values.length) {
      lines.push(...values);
    }
  });

  return lines;
}

/**
 * 把 MediaWiki `action=parse&prop=text` 返回的 HTML 抽成纯净正文。
 *
 * 标题会被写成 `## 标题` 的形式保留层级，方便模型理解上下文。
 */
export function extractPlainText(
  html: string,
  options: ExtractTextOptions = {},
): string {
  const { tableMode = "flatten", maxLength = 0 } = options;
  if (!html) return "";

  const $ = load(html);
  const root = $(".mw-parser-output").length
    ? $(".mw-parser-output").first()
    : $("body");

  if (tableMode === "drop") {
    root.find("table").remove();
  } else {
    // 信息框单独抽取：逐行「标签：值」，比整表压平更可读
    root.find(".infobox").each((_, element) => {
      const node = $(element);
      node.replaceWith($("<p></p>").text(flattenInfobox($, node).join("\n")));
    });

    // 其余正文表格压平（导航类表格直接丢弃）
    root.find("table").each((_, table) => {
      const node = $(table);
      if (node.is(NOISE_TABLE_SELECTOR)) {
        node.remove();
        return;
      }
      const rows: string[] = [];
      node.find("tr").each((__, tr) => {
        const cells: string[] = [];
        $(tr)
          .find("th,td")
          .each((___, cell) => {
            const value = squashInline($(cell).text());
            if (value) cells.push(value);
          });
        if (cells.length) rows.push(cells.join(" | "));
      });
      node.replaceWith($("<p></p>").text(rows.join("\n")));
    });
  }

  root.find(NOISE_SELECTOR).remove();

  const blocks: string[] = [];
  root.find(BLOCK_SELECTOR).each((_, element) => {
    const node = $(element);
    const tag = "tagName" in element ? String(element.tagName).toLowerCase() : "";

    // 列表项里嵌套的子列表会由后续的 <li> 单独输出，
    // 这里必须先把它们摘掉，否则同一段文字会出现多次。
    const raw =
      tag === "li" || tag === "dt" || tag === "dd"
        ? node.clone().find("ul,ol,dl,table").remove().end().text()
        : node.text();

    const text = squash(raw);
    if (!text) return;

    if (/^h[1-6]$/.test(tag)) {
      blocks.push(`${"#".repeat(Number(tag[1]))} ${text}`);
    } else {
      blocks.push(text);
    }
  });

  let plain = blocks.length ? blocks.join("\n") : squash(root.text());
  plain = squash(plain);

  if (maxLength > 0 && plain.length > maxLength) {
    plain = plain.slice(0, maxLength).trimEnd();
  }
  return plain;
}

/** 归一化空白：行内多空格压成一个，保留换行表达段落结构 */
export function squash(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/)
    .map((line) => squashInline(line))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function squashInline(text: string): string {
  return text.replace(/[ \t\u3000]+/g, " ").trim();
}

