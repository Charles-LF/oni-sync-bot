import { load } from "cheerio";

/**
 * HTML → 纯文本 / 文本切块。
 *
 * 这里只放**纯函数**：不依赖 Koishi Context、不发请求，因此可以被单元测试直接覆盖
 * （见 tests/renderText.spec.ts）。
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

/** 切块时优先在这些字符后断开（按优先级尝试） */
const BOUNDARY_SEPARATORS = ["\n", "。", "！", "？", "；", "，"];

/**
 * 分组标题行：信息框的 `[效果]` / `[建造]`，或整页标题 `【电解器】`。
 * 命中时若当前块已经有料，就先落块——否则「电力：消耗 120 瓦」会被
 * 建造/工作条件等无关行稀释，检索「耗电多少」时排不上来。
 */
const GROUP_HEADER_PATTERN = /^(\[[^\]\n]{1,20}\]|【[^】\n]{1,30}】)/;

/** 当前块至少有这么长，遇到分组标题才切分（避免产生一堆碎片块） */
const GROUP_SPLIT_MIN = 120;

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

export interface TextChunk {
  index: number;
  text: string;
}

export interface ChunkOptions {
  /** 目标块大小（字符数） */
  size?: number;
  /** 相邻块的重叠字符数 */
  overlap?: number;
  /** 最多产出多少块 */
  maxChunks?: number;
}

/**
 * 按行切块：优先在段落/分组标题处断开，块与块之间保留少量重叠。
 *
 * 中文没有空格分词，按字符长度切比按 token 切更简单也更可控；
 * `bge-small-zh` 的输入上限是 512 token，默认 350 字符留有余量。
 *
 * 两条关键规则（直接影响检索命中率）：
 * 1. 遇到 `[效果]` / `【电解器】` 这类分组标题且当前块已有 ≥120 字时先落块，
 *    避免「电力：消耗 120 瓦」被建造、工作条件等无关行稀释；
 * 2. 重叠区从行首开始，避免把半个词带进下一块。
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const source = squash(text ?? "");
  if (!source) return [];

  const size = Math.max(80, Math.floor(options.size ?? 350));
  const overlap = Math.max(
    0,
    Math.min(Math.floor(options.overlap ?? 60), Math.floor(size / 2)),
  );
  const maxChunks = Math.max(1, Math.floor(options.maxChunks ?? 24));

  const chunks: TextChunk[] = [];
  let current: string[] = [];
  let currentLength = 0;

  const flush = () => {
    const value = current.join("\n").trim();
    if (value) chunks.push({ index: chunks.length, text: value });
    current = [];
    currentLength = 0;
  };

  /** 上一块的尾部若干行，作为新块的重叠，从行首开始 */
  const carryOverlap = (): string[] => {
    if (overlap <= 0 || chunks.length === 0) return [];
    const previous = chunks[chunks.length - 1].text;
    const tail = previous.slice(-overlap);
    const lineBreak = tail.indexOf("\n");
    const piece = (lineBreak >= 0 ? tail.slice(lineBreak + 1) : tail).trim();
    return piece ? piece.split("\n") : [];
  };

  for (const line of source.split("\n")) {
    if (chunks.length >= maxChunks) break;

    if (GROUP_HEADER_PATTERN.test(line) && currentLength >= GROUP_SPLIT_MIN) {
      flush();
    }

    if (currentLength > 0 && currentLength + line.length + 1 > size) {
      const carry = carryOverlap();
      flush();
      if (carry.length > 0) {
        current = carry.slice();
        currentLength = current.reduce((sum, item) => sum + item.length + 1, 0);
      }
    }

    if (line.length > size) {
      // 单行超长（例如没有标点的长句）：按自然断点强切
      for (const piece of splitLongLine(line, size)) {
        if (chunks.length >= maxChunks) break;
        if (currentLength + piece.length + 1 > size) flush();
        current.push(piece);
        currentLength += piece.length + 1;
      }
      continue;
    }

    current.push(line);
    currentLength += line.length + 1;
  }

  flush();
  return chunks.slice(0, maxChunks);
}

/** 把超长单行按句读切成若干段 */
function splitLongLine(line: string, size: number): string[] {
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > size) {
    const cut = findBoundary(rest.slice(0, size), size);
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter(Boolean);
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

/** 在切片后半段找一个自然断点；找不到就整段切开 */
function findBoundary(slice: string, size: number): number {
  const minimum = Math.floor(size / 2);
  for (const separator of BOUNDARY_SEPARATORS) {
    const at = slice.lastIndexOf(separator);
    if (at >= minimum) return at + 1;
  }
  return slice.length;
}
