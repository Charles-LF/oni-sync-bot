import assert from "node:assert/strict";
import { nextCronTime, parseCron } from "../src/utils/cron";

/** 断言生成的 Date 与「本地时间字符串」一致，避免受运行环境时区影响 */
function expectNext(
  expression: string,
  from: string,
  expected: string | undefined,
) {
  const next = nextCronTime(parseCron(expression), new Date(from));
  assert.equal(
    next ? format(next) : undefined,
    expected,
    `${expression} from ${from}`,
  );
}

function format(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

describe("utils/cron 解析", () => {
  it("解析 5 段表达式", () => {
    const schedule = parseCron("15 3 * * *");
    assert.deepEqual([...schedule.minutes], [15]);
    assert.deepEqual([...schedule.hours], [3]);
    assert.equal(schedule.daysOfMonth.size, 31);
    assert.equal(schedule.months.size, 12);
    assert.equal(schedule.daysOfWeek.size, 7);
  });

  it("支持步长、范围与逗号组合", () => {
    assert.deepEqual([...parseCron("*/15 * * * *").minutes], [0, 15, 30, 45]);
    assert.deepEqual([...parseCron("0 8-10 * * *").hours], [8, 9, 10]);
    assert.deepEqual([...parseCron("0 0 * * 1,3,5").daysOfWeek], [1, 3, 5]);
    assert.deepEqual([...parseCron("0 0 1-5/2 * *").daysOfMonth], [1, 3, 5]);
  });

  it("把星期 7 归一为周日 0", () => {
    const schedule = parseCron("0 0 * * 7");
    assert.deepEqual([...schedule.daysOfWeek], [0]);
  });

  it("支持英文缩写与宏", () => {
    assert.deepEqual([...parseCron("0 0 1 JAN *").months], [1]);
    assert.deepEqual([...parseCron("0 0 * * MON").daysOfWeek], [1]);
    expectNext("@daily", "2026-11-22T10:00:00", "2026-11-23 00:00");
    expectNext("@weekly", "2026-11-22T10:00:00", "2026-11-29 00:00");
  });

  it("标记日/周字段是否受限（决定 OR 还是 AND 语义）", () => {
    const both = parseCron("0 0 1 * 1");
    assert.equal(both.domRestricted, true);
    assert.equal(both.dowRestricted, true);

    const onlyDom = parseCron("0 0 1 * *");
    assert.equal(onlyDom.domRestricted, true);
    assert.equal(onlyDom.dowRestricted, false);
  });

  it("非法表达式抛错", () => {
    for (const bad of [
      "",
      "* * * *",
      "* * * * * * *",
      "60 * * * *",
      "* 24 * * *",
      "0 0 0 * *",
      "0 0 * 13 *",
      "abc def ghi jkl mno",
      "*/0 * * * *",
    ]) {
      assert.throws(() => parseCron(bad), Error, `应拒绝：${bad}`);
    }
  });

  it("6 段表达式把第一段当秒（兼容原 cron 插件的写法）", () => {
    const schedule = parseCron("0 0 2 * * 0");
    assert.deepEqual([...schedule.seconds], [0]);
    assert.deepEqual([...schedule.minutes], [0]);
    assert.deepEqual([...schedule.hours], [2]);
    assert.deepEqual([...schedule.daysOfWeek], [0]);

    assert.deepEqual([...parseCron("30 * * * * *").seconds], [30]);
    assert.deepEqual([...parseCron("15 * * * *").seconds], [0]);
  });
});

describe("utils/cron 下次触发时间", () => {
  it("严格晚于当前时间（同一分钟已过就不再触发）", () => {
    expectNext("15 * * * *", "2026-11-22T23:21:00", "2026-11-23 00:15");
    expectNext("15 * * * *", "2026-11-22T23:14:00", "2026-11-22 23:15");
    expectNext("15 * * * *", "2026-11-22T23:15:00", "2026-11-23 00:15");
  });

  it("每日固定时间（项目里的 updateCron 默认值）", () => {
    expectNext("0 2 * * *", "2026-11-22T23:21:00", "2026-11-23 02:00");
    expectNext("0 2 * * *", "2026-11-23T01:30:00", "2026-11-23 02:00");
  });

  it("每周任务（含星期跳跃）", () => {
    // 2026-11-22 是周日
    expectNext("0 0 * * 1", "2026-11-22T23:21:00", "2026-11-23 00:00");
    expectNext("30 8 * * 4", "2026-11-22T23:21:00", "2026-11-26 08:30");
    expectNext("30 8 * * 3", "2026-11-22T23:21:00", "2026-11-25 08:30");
    expectNext("0 0 2 * * 0", "2026-11-22T23:21:00", "2026-11-29 02:00");
  });

  it("每小时增量同步", () => {
    expectNext("15 * * * *", "2026-11-22T22:40:00", "2026-11-22 23:15");
  });

  it("跨月跳跃", () => {
    expectNext("0 0 1 * *", "2026-11-22T23:21:00", "2026-12-01 00:00");
  });

  it("日与周同时受限时取 OR（每月 1 号 或 每周一）", () => {
    expectNext("0 0 1 * 1", "2026-11-22T23:21:00", "2026-11-23 00:00");
    expectNext("0 0 1 * 1", "2026-11-24T00:00:00", "2026-11-30 00:00");
  });

  it("闰日也能找到（4 年内）", () => {
    expectNext("0 0 29 2 *", "2026-11-22T00:00:00", "2028-02-29 00:00");
  });

  it("找不到触发时间时返回 undefined", () => {
    // 2 月 30 日永远不存在
    assert.equal(nextCronTime(parseCron("0 0 30 2 *"), new Date("2026-01-01T00:00:00")), undefined);
  });
});
