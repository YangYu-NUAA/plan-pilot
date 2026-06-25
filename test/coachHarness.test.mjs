import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyDraft, mergeCoachDraft, actionToItem, coachMessageFrom } from "../src/coachHarness.js";

test("mergeCoachDraft：多个不同目标都保留，不被误并", () => {
  const items = [
    { kind: "goal", type: "long", title: "长期目标甲" },
    { kind: "goal", type: "long", title: "长期目标乙" },
    { kind: "goal", type: "long", title: "长期目标丙" },
  ];
  const d = mergeCoachDraft(emptyDraft(), items);
  assert.equal(d.goals.length, 3);
});

test("mergeCoachDraft：同名（归一相等）目标去重，跨批累积", () => {
  let d = mergeCoachDraft(emptyDraft(), [{ kind: "goal", type: "long", title: "撰写项目申请书" }]);
  d = mergeCoachDraft(d, [
    { kind: "goal", type: "long", title: "撰写项目申请书。" }, // 仅标点不同 → 视为同一
    { kind: "goal", type: "long", title: "明年的另一份申请" },
  ]);
  assert.equal(d.goals.length, 2);
});

test("mergeCoachDraft：同名但不同 type 不算重复；kind 分流正确", () => {
  const d = mergeCoachDraft(emptyDraft(), [
    { kind: "goal", type: "long", title: "课题甲" },
    { kind: "goal", type: "month", title: "课题甲" },
    { kind: "task", date: "2026-06-26", title: "读参考代码" },
    { kind: "busy", date: "2026-06-26", title: "组会", start: "14:00", end: "15:00" },
  ]);
  assert.equal(d.goals.length, 2);
  assert.equal(d.tasks.length, 1);
  assert.equal(d.busy.length, 1);
});

test("mergeCoachDraft：空标题忽略、不修改原草稿", () => {
  const before = mergeCoachDraft(emptyDraft(), [{ kind: "goal", type: "long", title: "A" }]);
  const after = mergeCoachDraft(before, [{ kind: "goal", type: "long", title: "  " }]);
  assert.equal(before.goals.length, 1);
  assert.equal(after.goals.length, 1);
});

test("actionToItem：add_* 映射到对应 kind，ask/未知返回 null", () => {
  assert.deepEqual(
    actionToItem({ type: "add_goal", goalType: "long", title: "课题甲", priority: "high", tempId: "g1", parentRef: "g0" }),
    { kind: "goal", type: "long", title: "课题甲", priority: "high", parentId: "g0", parentTitle: "", tempId: "g1" },
  );
  assert.equal(actionToItem({ type: "add_task", title: "读参考代码", date: "2026-06-26", goalRef: "g1" }).kind, "task");
  assert.equal(actionToItem({ type: "add_busy", title: "组会", start: "14:00", end: "15:00" }).kind, "busy");
  assert.equal(actionToItem({ type: "ask", question: "有具体课题吗？" }), null);
  assert.equal(actionToItem({ type: "done" }), null);
  assert.equal(actionToItem(null), null);
});

test("actionToItem：非法 goalType 不硬塞（留空交给 normalize 兜底）", () => {
  assert.equal(actionToItem({ type: "add_goal", goalType: "huge", title: "x" }).type, "");
});

test("coachMessageFrom：优先 message，否则取 ask 的 question", () => {
  assert.equal(coachMessageFrom({ message: "好的", actions: [{ type: "ask", question: "q" }] }), "好的");
  assert.equal(coachMessageFrom({ message: "  ", actions: [{ type: "ask", question: "你有具体课题吗？" }] }), "你有具体课题吗？");
  assert.equal(coachMessageFrom({ actions: [{ type: "add_goal", title: "x" }] }), "");
});
