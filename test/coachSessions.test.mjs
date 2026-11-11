import assert from "node:assert/strict";
import test from "node:test";

import { collectCoachItems, filterCoachItems, normalizeCoachItems } from "../src/planner/coachItems.js";

const date = "2026-11-11";
const planner = {
  goals: [],
  tasks: [{ id: "t-deep", title: "写技术路线", date, status: "open" }],
  blocks: [],
};
const actions = [
  { type: "add_session", taskRef: "t-deep", title: "写技术路线", date, start: "09:00", end: "11:00" },
  { type: "add_session", taskRef: "t-deep", title: "写技术路线", date, start: "14:00", end: "16:00" },
];

test("智能体 add_session：归一化后保留同任务两个非重叠工作段", () => {
  const items = normalizeCoachItems(collectCoachItems({ actions }), date);
  const kept = filterCoachItems(items, planner);
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((item) => [item.kind, item.taskId, item.start, item.end]), [
    ["session", "t-deep", "09:00", "11:00"],
    ["session", "t-deep", "14:00", "16:00"],
  ]);
});

test("智能体 add_session：冲突段和未知任务不会落库", () => {
  const items = normalizeCoachItems(collectCoachItems({ actions: [actions[0], { ...actions[1], start: "10:30", end: "12:00" }] }), date);
  const kept = filterCoachItems(items, {
    ...planner,
    blocks: [{ id: "b-existing", taskId: "t-deep", type: "task", date, start: "09:00", end: "10:00" }],
  });
  assert.equal(kept.length, 1, "冲突的第一段被拒绝，可用的第二段仍可接受");
  assert.equal(kept[0].start, "10:30");
  assert.equal(filterCoachItems(normalizeCoachItems(collectCoachItems({ actions: [{ ...actions[0], taskRef: "missing", title: "不存在" }] }), date), planner).length, 0);
});
