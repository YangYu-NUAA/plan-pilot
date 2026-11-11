import assert from "node:assert/strict";
import test from "node:test";

import { compactPlannerTasks } from "../src/planner/dedup.js";
import { findBlockCopySlot, normalizeAiScheduleResult } from "../src/planner/scheduling.js";
import { isTaskSessionDone, setTaskSessionDone, splitTaskBlock } from "../src/planner/taskSessions.js";

const date = "2026-11-11";
const settings = {
  workSegments: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }],
  breaks: [],
  shortBreak: 10,
  longBreak: 30,
};
const task = {
  id: "t-deep",
  title: "撰写项目申请书技术路线",
  date,
  estimateMinutes: 240,
  priority: "high",
  status: "open",
  fixedTime: false,
};
const morning = { id: "b-morning", taskId: task.id, type: "task", date, start: "09:00", end: "11:00", auto: true };
const afternoon = { id: "b-afternoon", taskId: task.id, type: "task", date, start: "14:00", end: "16:00", auto: true };

test("AI 多段任务：同一 taskId 的上午/下午块都保留，并尊重各自结束时间", () => {
  const result = normalizeAiScheduleResult(
    { blocks: [morning, afternoon].map(({ start, end }) => ({ taskId: task.id, start, end })), questions: [] },
    { tasks: [task], existingBlocks: [], settings, selectedDate: date },
  );
  const sessions = result.blocks.filter((block) => block.taskId === task.id);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((block) => [block.start, block.end]), [["09:00", "11:00"], ["14:00", "16:00"]]);
  assert.equal(result.tasks.filter((item) => item.id === task.id).length, 1);
  assert.equal(result.questions.some((question) => question.taskId === task.id), false);
});

test("AI 多段任务：重叠的重复段仍会被拒绝", () => {
  const result = normalizeAiScheduleResult(
    { blocks: [morning, { ...morning, start: "10:30", end: "12:00" }], questions: [] },
    { tasks: [task], existingBlocks: [], settings, selectedDate: date },
  );
  assert.equal(result.blocks.filter((block) => block.taskId === task.id).length, 1);
});

test("手动接管一段后重排：同任务的其他自动段不会被清除", () => {
  const manualMorning = { ...morning, auto: false };
  const result = normalizeAiScheduleResult(
    { blocks: [], questions: [] },
    { tasks: [task], existingBlocks: [manualMorning, afternoon], settings, selectedDate: date },
  );
  assert.deepEqual(result.blocks.filter((block) => block.taskId === task.id).map((block) => block.id).sort(), ["b-afternoon", "b-morning"]);
});

test("压缩去重：只清理重叠重复段，不删除同任务的非重叠段", () => {
  const result = compactPlannerTasks([task], [morning, afternoon]);
  assert.deepEqual(result.blocks.map((block) => block.id), ["b-morning", "b-afternoon"]);
});

test("拆分：从中间生成同任务两段，过短块拒绝拆分", () => {
  const pieces = splitTaskBlock({ ...morning, end: "13:00" }, () => "b-second");
  assert.equal(pieces.length, 2);
  assert.deepEqual(pieces.map((block) => [block.start, block.end]), [["09:00", "11:00"], ["11:00", "13:00"]]);
  assert.equal(pieces[0].taskId, task.id);
  assert.equal(pieces[1].taskId, task.id);
  assert.equal(pieces[1].id, "b-second");
  assert.equal(pieces.every((block) => block.auto === false), true);
  assert.equal(splitTaskBlock({ ...morning, end: "09:20" }, () => "unused"), null);
});

test("复制：优先使用源块之后能容纳完整时长的真实空档", () => {
  const slot = findBlockCopySlot(morning, [morning], settings);
  assert.deepEqual(slot, { start: "14:00", end: "16:00" });
  assert.equal(findBlockCopySlot(morning, [morning, { ...afternoon }], { ...settings, workSegments: [{ start: "09:00", end: "12:00" }] }), null);
});

test("分段打卡：完成上午段不完成下午段，全部完成后任务才完成", () => {
  let state = setTaskSessionDone([task], [morning, afternoon], morning.id, true);
  assert.equal(state.tasks[0].status, "open");
  assert.equal(state.blocks[0].done, true);
  assert.equal(state.blocks[0].auto, false, "完成段应固定保留，避免重排删除历史");
  assert.equal(isTaskSessionDone(state.blocks[0], state.tasks[0]), true);
  assert.equal(isTaskSessionDone(state.blocks[1], state.tasks[0]), false);

  state = setTaskSessionDone(state.tasks, state.blocks, afternoon.id, true);
  assert.equal(state.tasks[0].status, "done");
  state = setTaskSessionDone(state.tasks, state.blocks, morning.id, false);
  assert.equal(state.tasks[0].status, "open");

  const single = setTaskSessionDone([task], [morning], morning.id, true);
  assert.equal(single.tasks[0].status, "done", "单段任务保持原有整体打卡行为");
});
