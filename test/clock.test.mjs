import { test } from "node:test";
import assert from "node:assert/strict";
import { appNow, isValidTimeZone, setActiveTimeZone, getActiveTimeZone } from "../src/utils/clock.js";
import { getLocalDate } from "../src/utils/dateTime.js";

// 固定一个 UTC 时刻做断言（各时区分量唯一确定，不受运行机器时区影响）
const T = () => new Date("2026-11-10T16:30:00Z"); // UTC 16:30

test("isValidTimeZone：合法/非法时区名", () => {
  assert.equal(isValidTimeZone("Asia/Shanghai"), true);
  assert.equal(isValidTimeZone("America/New_York"), true);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
  assert.equal(isValidTimeZone(""), false);
  assert.equal(isValidTimeZone(null), false);
});

test("appNow 按所选时区给出时分（上海 00:30 次日 / 纽约 11:30 当日）", () => {
  setActiveTimeZone("Asia/Shanghai");
  const sh = appNow(T());
  assert.equal(sh.getHours(), 0);
  assert.equal(sh.getMinutes(), 30);

  setActiveTimeZone("America/New_York");
  const ny = appNow(T());
  assert.equal(ny.getHours(), 11);
  assert.equal(ny.getMinutes(), 30);

  setActiveTimeZone(null); // 跟随系统：返回原对象
  assert.equal(appNow(T()).getTime(), T().getTime());
});

test("getLocalDate 随 App 时区跨日（上海已是次日，纽约还是当日）", () => {
  // 业务代码全部无参调用（默认走 appNow）；显式传参须先经 appNow 偏移
  setActiveTimeZone("Asia/Shanghai");
  assert.equal(getLocalDate(appNow(T())), "2026-11-11");
  setActiveTimeZone("America/New_York");
  assert.equal(getLocalDate(appNow(T())), "2026-11-10");
  setActiveTimeZone("UTC");
  assert.equal(getLocalDate(appNow(T())), "2026-11-10");
  setActiveTimeZone(null);
});

test("夏令时边界：纽约 7 月（EDT, UTC-4）与 11 月（EST, UTC-5）偏移不同", () => {
  const jul = new Date("2026-07-10T16:30:00Z");
  setActiveTimeZone("America/New_York");
  assert.equal(appNow(jul).getHours(), 12); // EDT
  assert.equal(appNow(T()).getHours(), 11); // EST
  setActiveTimeZone(null);
});

test("getActiveTimeZone 回读", () => {
  setActiveTimeZone("Asia/Tokyo");
  assert.equal(getActiveTimeZone(), "Asia/Tokyo");
  setActiveTimeZone("Bad/Zone");
  assert.equal(getActiveTimeZone(), null); // 非法名回落跟随系统
  setActiveTimeZone(null);
});
