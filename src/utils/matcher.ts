/**
 * 页面查询的匹配与打分逻辑。
 *
 * 这里只放**纯函数**：不依赖 Koishi Context、不做 I/O、不涉及消息渲染，
 * 因此可以直接被单元测试覆盖（见 tests/matcher.spec.ts）。
 */

/** 结构上兼容 `WikiPages` */
export interface ScorablePage {
  id: number;
  title: string;
  pinyin_full: string;
  pinyin_first: string;
}

export interface MatchResult {
  id: number;
  title: string;
  score: number;
}

export function getCommonPrefixLength(a: string, b: string): number {
  const minLen = Math.min(a.length, b.length);
  let i = 0;
  while (i < minLen && a[i] === b[i]) i++;
  return i;
}

/**
 * 为单个页面打分，分数越大越相关，0 表示不匹配。
 *
 * 计分项（每一项都要求对应的查询串**非空**）：
 * - 标题包含关键词：+10
 * - 全拼以关键词全拼开头：+9，仅包含：+8
 * - 首字母包含关键词首字母：+6
 * - 标题与关键词公共前缀 >= 2：加前缀长度
 * - 全拼与关键词全拼公共前缀 >= 3：加其一半（向下取整）
 *
 * 为什么必须逐项判空：`"任意串".includes("")` 与 `"任意串".startsWith("")` 都恒为 true。
 * - 纯拉丁查询（如 `Refinery`）的首字母是空串，不判空则**每个页面白得 6 分**；
 * - 完全由符号组成的查询（如 `!!!`）全拼与首字母都为空，不判空则**每页白得 23 分**。
 *
 * 两种情况都会把"没有匹配"变成"返回若干随机页面"。
 */
export function calculateScore(
  page: ScorablePage,
  queryKey: string,
  queryPinyinFull: string,
  queryPinyinFirst: string,
): number {
  let score = 0;
  const { title, pinyin_full, pinyin_first } = page;

  if (queryKey && title.includes(queryKey)) score += 10;
  if (queryPinyinFull) {
    if (pinyin_full.startsWith(queryPinyinFull)) score += 9;
    if (pinyin_full.includes(queryPinyinFull)) score += 8;
  }
  if (queryPinyinFirst && pinyin_first.includes(queryPinyinFirst)) score += 6;

  // 公共前缀匹配：标题或拼音有较长公共前缀时给予评分
  // （空串在这里天然安全：公共前缀长度恒为 0，达不到下面的阈值）
  const titlePrefixLen = getCommonPrefixLength(title, queryKey);
  if (titlePrefixLen >= 2) {
    score += titlePrefixLen;
  }
  const pinyinPrefixLen = getCommonPrefixLength(pinyin_full, queryPinyinFull);
  if (pinyinPrefixLen >= 3) {
    score += Math.floor(pinyinPrefixLen / 2);
  }

  return score;
}

/**
 * 模糊匹配：打分后按分数降序、同分按标题短的优先，标题去重，最多取 `limit` 条。
 */
export function findFuzzyMatches(
  allPages: ScorablePage[],
  queryKey: string,
  queryPinyinFull: string,
  queryPinyinFirst: string,
  limit = 5,
): MatchResult[] {
  const matchResults: MatchResult[] = [];

  for (const page of allPages) {
    const score = calculateScore(
      page,
      queryKey,
      queryPinyinFull,
      queryPinyinFirst,
    );
    if (score > 0) {
      matchResults.push({ id: page.id, title: page.title, score });
    }
  }

  return matchResults
    .sort((a, b) => b.score - a.score || a.title.length - b.title.length)
    .filter(
      (item, index, array) =>
        array.findIndex((t) => t.title === item.title) === index,
    )
    .slice(0, limit);
}
