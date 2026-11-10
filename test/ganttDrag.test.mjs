import test from "node:test";
import assert from "node:assert/strict";
import { buildGoalGantt } from "../src/planner/gantt.js";
import { getGanttDragUpdate, isGanttBarMovable } from "../src/planner/ganttDrag.js";
import { addDays } from "../src/utils/dateTime.js";

const TODAY = "2026-01-01";
const explicitGoal = {
  id: "goal",
  type: "month",
  title: "显式目标",
  startDate: "2026-01-10",
  endDate: "2026-01-12",
};

test("buildGoalGantt：只有自身显式日期的跨度为 pure-explicit 且可拖", () => {
  const { rows } = buildGoalGantt([explicitGoal], [], TODAY);
  assert.equal(rows[0].span.derived, "explicit");
  assert.equal(rows[0].span.start, "2026-01-10");
  assert.equal(rows[0].span.end, "2026-01-12");
  assert.equal(isGanttBarMovable(explicitGoal, rows[0].span), true);
});

test("buildGoalGantt：显式日期与关联任务组成 mixed，禁止只拖目标日期", () => {
  const task = { id: "task", goalId: "goal", date: "2026-01-05" };
  const { rows } = buildGoalGantt([explicitGoal], [task], TODAY);
  assert.equal(rows[0].span.derived, "mixed");
  assert.equal(rows[0].span.start, "2026-01-05");
  assert.equal(rows[0].span.end, "2026-01-12");
  assert.equal(isGanttBarMovable(explicitGoal, rows[0].span), false);
});

test("buildGoalGantt：显式日期与子目标跨度组成 mixed，父目标不可拖", () => {
  const parent = { ...explicitGoal, id: "parent", type: "long" };
  const child = {
    ...explicitGoal,
    id: "child",
    parentId: "parent",
    startDate: "2026-01-05",
    endDate: "2026-01-06",
  };
  const { rows } = buildGoalGantt([parent, child], [], TODAY);
  const byId = Object.fromEntries(rows.map((row) => [row.goal.id, row]));
  assert.equal(byId.parent.span.derived, "mixed");
  assert.equal(byId.parent.span.start, "2026-01-05");
  assert.equal(isGanttBarMovable(parent, byId.parent.span), false);
  assert.equal(byId.child.span.derived, "explicit");
  assert.equal(isGanttBarMovable(child, byId.child.span), true);
});

test("pointercancel：即使已有非零位移也只取消，不生成日期提交", () => {
  const drag = {
    goalId: "goal",
    origStart: "2026-01-10",
    origEnd: "2026-01-12",
    shift: 3,
  };
  assert.equal(getGanttDragUpdate(drag, "pointercancel", addDays), null);
});

test("pointerup：提交整体按天平移并保持时长；零位移不提交", () => {
  const drag = {
    goalId: "goal",
    origStart: "2026-01-10",
    origEnd: "2026-01-12",
    shift: 3,
  };
  assert.deepEqual(getGanttDragUpdate(drag, "pointerup", addDays), {
    goalId: "goal",
    startDate: "2026-01-13",
    endDate: "2026-01-15",
  });
  assert.equal(getGanttDragUpdate({ ...drag, shift: 0 }, "pointerup", addDays), null);
});
