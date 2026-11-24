import type { IgnoreRule } from "./ignoreRule";

/**
 * 内置默认忽略规则。
 *
 * 规则本身仍然只存在 `sync_ignore` 表里（管理员可以随时用 `sync.ignore.remove`
 * 删掉、或用 `sync.ignore.add` 改原因），这里只是给新装 / 升级的库**补种一次**
 * 初始名单：`IGNORE_SEED_VERSION` 记住「已经补过哪一版」，同版本重启不会重复塞，
 * 所以管理员删掉的规则不会被下次启动硬塞回来。
 */
export const IGNORE_SEED_VERSION = "2026-11-24";

/** 目标站直接拒绝或反复传不上去的图片：`.ico` 不在允许类型内，GIF 超过体积上限 */
export const DEFAULT_IGNORE_RULES: IgnoreRule[] = [
  { type: "image", name: "Favicon.ico", reason: "目标站不允许 .ico 文件类型" },
  { type: "image", name: "Site-favicon.ico", reason: "目标站不允许 .ico 文件类型" },
  {
    type: "image",
    name: "EX1-453222.gif",
    reason: "上传返回 413 Payload Too Large（文件超出目标站体积上限）",
  },
  {
    type: "image",
    name: "EX1-456658.gif",
    reason: "传输反复中断（TLS bad record mac），文件过大",
  },
  {
    type: "image",
    name: "EX1-462129.gif",
    reason: "上传返回 413 Payload Too Large（文件超出目标站体积上限）",
  },
  {
    type: "image",
    name: "U37-482255.gif",
    reason: "上传返回 413 Payload Too Large（文件超出目标站体积上限）",
  },
  {
    type: "image",
    name: "U51-594211.gif",
    reason: "上传返回 413 Payload Too Large（文件超出目标站体积上限）",
  },
];
