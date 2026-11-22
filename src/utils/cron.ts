/**
 * cron 表达式解析与下次触发时间计算（纯函数，本地时区）。
 *
 * 支持 5 段（分 时 日 月 周）与 6 段（**秒** 分 时 日 月 周），
 * 字段可用 `*`、`N`、`a-b`、`* /n`、`a-b/n`、逗号组合、月份/星期英文缩写，
 * 也支持 `@daily` 之类的宏。日与周同时受限时按 Vixie cron 的 OR 语义。
 */

export interface CronSchedule {
  /** 原始表达式，便于日志展示 */
  expression: string;
  seconds: Set<number>;
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** 日字段是否受限（不是纯粹的 `*`），用于 OR/AND 语义判定 */
  domRestricted: boolean;
  /** 周字段是否受限 */
  dowRestricted: boolean;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** 常用宏 → 5 段表达式 */
const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/** 向后搜索的年数上限（覆盖闰日 2/29） */
const SEARCH_YEARS = 4;

function toValue(token: string, names?: Record<string, number>): number {
  const key = token.trim().toLowerCase();
  if (names && key in names) return names[key];
  const value = Number(key);
  if (!Number.isInteger(value)) throw new Error(`无效字段值：${token}`);
  return value;
}

/** 解析单个字段（支持逗号段落 / 范围 / 步长 / 英文缩写） */
function parseField(
  raw: string,
  min: number,
  max: number,
  names?: Record<string, number>,
): Set<number> {
  const values = new Set<number>();

  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (!piece) continue;

    const [rangePart, stepPart] = piece.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`无效步长：${piece}`);
    }

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [from, to] = rangePart.split("-");
      start = toValue(from, names);
      end = toValue(to, names);
    } else {
      start = toValue(rangePart, names);
      // `5/10` 表示从 5 开始按步长走到上限
      end = stepPart === undefined ? start : max;
    }

    if (start < min || end > max || start > end) {
      throw new Error(`字段超出范围 ${min}-${max}：${piece}`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }

  if (values.size === 0) throw new Error(`字段为空：${raw}`);
  return values;
}

/**
 * 解析 cron 表达式（5 段 = 分 时 日 月 周；6 段 = 秒 分 时 日 月 周），非法时抛错。
 *
 * 星期 0 与 7 都表示周日（cron 惯例），内部统一为 0。
 */
export function parseCron(expression: string): CronSchedule {
  const source = (expression ?? "").trim();
  if (!source) throw new Error("cron 表达式为空");

  const normalized = MACROS[source.toLowerCase()] ?? source;
  const fields = normalized.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    throw new Error(
      `需要 5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周），实际 ${fields.length} 段：${expression}`,
    );
  }

  const [secondField, minuteField, hourField, domField, monthField, dowField] =
    fields.length === 6 ? fields : ["0", ...fields];

  const daysOfWeek = parseField(dowField, 0, 7, DAY_NAMES);
  if (daysOfWeek.delete(7)) daysOfWeek.add(0);

  return {
    expression: source,
    seconds: parseField(secondField, 0, 59),
    minutes: parseField(minuteField, 0, 59),
    hours: parseField(hourField, 0, 23),
    daysOfMonth: parseField(domField, 1, 31),
    months: parseField(monthField, 1, 12, MONTH_NAMES),
    daysOfWeek,
    domRestricted: domField.trim() !== "*",
    dowRestricted: dowField.trim() !== "*",
  };
}

/** 日期是否命中「日 / 周」条件（两者都受限时取 OR，否则取 AND） */
function matchDay(schedule: CronSchedule, date: Date): boolean {
  const domOk = schedule.daysOfMonth.has(date.getDate());
  const dowOk = schedule.daysOfWeek.has(date.getDay());
  return schedule.domRestricted && schedule.dowRestricted
    ? domOk || dowOk
    : domOk && dowOk;
}

/**
 * 计算**严格晚于** `from` 的下一个触发时间，找不到返回 `undefined`。
 *
 * 按月 → 日 → 时 → 分逐级跳跃，命中分钟后再在同一分钟内挑秒，避免逐秒傻等。
 */
export function nextCronTime(
  schedule: CronSchedule,
  from: Date = new Date(),
): Date | undefined {
  const startYear = from.getFullYear();
  const seconds = [...schedule.seconds].sort((a, b) => a - b);

  const cursor = new Date(from.getTime());
  cursor.setMilliseconds(0);
  cursor.setSeconds(cursor.getSeconds() + 1);

  // 每轮至少推进一秒，上限按 4 年的分钟数留足余量
  for (let guard = 0; guard < 60 * 24 * 366 * SEARCH_YEARS; guard++) {
    if (cursor.getFullYear() - startYear > SEARCH_YEARS) return undefined;

    if (!schedule.months.has(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!matchDay(schedule, cursor)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!schedule.hours.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!schedule.minutes.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }

    // 分钟已命中：在本分钟内找第一个不早于当前秒的触发点
    const second = seconds.find((value) => value >= cursor.getSeconds());
    if (second === undefined) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }
    cursor.setSeconds(second, 0);
    return new Date(cursor.getTime());
  }
  return undefined;
}
