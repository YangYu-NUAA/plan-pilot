import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommandInput } from "../src/utils/commandParse.js";

// 固定「今天」为 2026-07-23（周四），所有相对日期据此推导
const CTX = { selectedDate: "2026-07-23", todayStr: "2026-07-23" };

test("空输入 / 无意义输入", () => {
  assert.deepEqual(parseCommandInput("", CTX), []);
  assert.deepEqual(parseCommandInput("   ", CTX), []);
  assert.deepEqual(parseCommandInput("嗯", CTX).length > 0, true); // 有标题就建任务
});

test("纯命令：专注 / 视图 / 设置 / 主题", () => {
  assert.equal(parseCommandInput("专注", CTX)[0].kind, "focus");
  assert.equal(parseCommandInput("复盘", CTX)[0].view, "review");
  assert.equal(parseCommandInput("目标", CTX)[0].view, "goals");
  assert.equal(parseCommandInput("设置", CTX)[0].kind, "settings");
  assert.equal(parseCommandInput("主题 暗夜", CTX)[0].theme, "night");
  assert.equal(parseCommandInput("主题", CTX)[0].theme, null); // 循环
});

test("日期跳转：明天 / 后天 / 周五 / 8月1日 / 25号", () => {
  assert.deepEqual(parseCommandInput("明天", CTX)[0], {
    kind: "goto-date", date: "2026-07-24", label: "跳到明天（7月24日·周五）", hint: "",
  });
  assert.equal(parseCommandInput("后天", CTX)[0].date, "2026-07-25");
  assert.equal(parseCommandInput("周五", CTX)[0].date, "2026-07-24"); // 本周五（周四的明天）
  assert.equal(parseCommandInput("周四", CTX)[0].date, "2026-07-23"); // 本周四=今天
  assert.equal(parseCommandInput("下周一", CTX)[0].date, "2026-07-27");
  assert.equal(parseCommandInput("8月1日", CTX)[0].date, "2026-08-01");
  assert.equal(parseCommandInput("1月5日", CTX)[0].date, "2027-01-05"); // 已过 → 明年
  assert.equal(parseCommandInput("25号", CTX)[0].date, "2026-07-25");
  assert.equal(parseCommandInput("2026-08-10", CTX)[0].date, "2026-08-10");
});

test("时间段 + 标题 → 建块（busy 关键词识别）", () => {
  const [block, task] = parseCommandInput("明天下午3点到4点 组会", CTX);
  assert.equal(block.kind, "add-block");
  assert.equal(block.date, "2026-07-24");
  assert.equal(block.start, "15:00");
  assert.equal(block.end, "16:00");
  assert.equal(block.title, "组会");
  assert.equal(block.blockType, "busy"); // 「组会」是固定安排
  assert.equal(task.kind, "add-task"); // 始终提供仅建任务的退路
});

test("24 小时制与混合写法", () => {
  const [a] = parseCommandInput("15:30-16:30 写论文", CTX);
  assert.equal(a.start, "15:30");
  assert.equal(a.end, "16:30");
  assert.equal(a.blockType, "task");
  const [b] = parseCommandInput("晚上7点到8点半 健身", CTX);
  assert.equal(b.start, "19:00");
  assert.equal(b.end, "20:30");
  assert.equal(b.blockType, "busy");
});

test("单个时间点 + 时长 → 推算块尾", () => {
  const [block] = parseCommandInput("明天上午10点 写周报 30分钟", CTX);
  assert.equal(block.start, "10:00");
  assert.equal(block.end, "10:30");
  const [b2] = parseCommandInput("下午2点 改 bug 1.5小时", CTX);
  assert.equal(b2.start, "14:00");
  assert.equal(b2.end, "15:30");
});

test("仅标题 + 时长 → 仅建任务", () => {
  const intents = parseCommandInput("写周报 45分钟", CTX);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].kind, "add-task");
  assert.equal(intents[0].estimateMinutes, 45);
  assert.equal(intents[0].date, "2026-07-23"); // 未提日期 → 当前选中日期
});

test("仅标题 → 用标题估时", () => {
  const [t] = parseCommandInput("回复邮件", CTX);
  assert.equal(t.kind, "add-task");
  assert.ok(t.estimateMinutes >= 10 && t.estimateMinutes <= 30);
});

test("日期 + 任务（无时间）", () => {
  const [t] = parseCommandInput("下周一 交中期报告", CTX);
  assert.equal(t.kind, "add-task");
  assert.equal(t.date, "2026-07-27");
});
