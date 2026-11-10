import test from "node:test";
import assert from "node:assert/strict";
import {
  getFreeIntervals,
  buildAutoBlocks,
  findSlotForTask,
} from "../src/planner/scheduling.js";

const today = "2026-08-26";

const settings = {
  workSegments: [
    { start: "09:00", end: "12:00" },
    { start: "14:00", end: "18:00" },
  ],
  shortBreak: 10,
  longBreak: 30,
  breaks: [],
};

test("getFreeIntervals：notBefore 会把区间起点抬到当前时间", () => {
  const intervals = getFreeIntervals(settings, [], { notBefore: 600 }); // 10:00
  assert.equal(intervals[0].start, 600);
  assert.equal(intervals[0].end, 720);
  assert.equal(intervals[1].start, 840);
  assert.equal(intervals[1].end, 1080);
});

test("getFreeIntervals：notBefore 为 null 时不加限制", () => {
  const intervals = getFreeIntervals(settings, [], { notBefore: null });
  assert.equal(intervals[0].start, 540); // 09:00
});

test("buildAutoBlocks：自动块都排在当前时间之后", () => {
  const tasks = [
    {
      id: "t1",
      title: "写论文",
      date: today,
      estimateMinutes: 60,
      priority: "high",
      kind: "normal",
      status: "todo",
      fixedTime: false,
    },
  ];
  const result = buildAutoBlocks({
    tasks,
    existingBlocks: [],
    settings,
    selectedDate: today,
    notBefore: 600, // 10:00
  });
  assert.ok(result.blocks.length >= 1);
  assert.equal(result.blocks[0].start, "10:00");
  assert.equal(result.blocks[0].end, "11:00");
});

test("buildAutoBlocks：已过时的固定时间任务转为待确认问题，不生成块", () => {
  const tasks = [
    {
      id: "f1",
      title: "晨会",
      date: today,
      estimateMinutes: 30,
      priority: "high",
      kind: "normal",
      status: "todo",
      fixedTime: true,
      fixedStart: "08:30",
    },
    {
      id: "t1",
      title: "写论文",
      date: today,
      estimateMinutes: 60,
      priority: "medium",
      kind: "normal",
      status: "todo",
      fixedTime: false,
    },
  ];
  const result = buildAutoBlocks({
    tasks,
    existingBlocks: [],
    settings,
    selectedDate: today,
    notBefore: 600, // 10:00
  });
  const expiredQuestion = result.questions.find((q) => q.taskId === "f1");
  assert.ok(expiredQuestion, "应生成 f1 的待确认问题");
  assert.ok(expiredQuestion.reason.includes("已过"), "原因应说明时间已过");
  assert.ok(!result.blocks.some((b) => b.taskId === "f1"), "不应为已过时固定任务生成块");
  assert.ok(result.blocks.some((b) => b.taskId === "t1"), "其余任务仍正常排期");
});

test("findSlotForTask：notBefore 作为起点下限", () => {
  const slot = findSlotForTask(
    { title: "写论文", estimateMinutes: 60, date: today, fixedTime: false },
    settings,
    [],
    today,
    { notBefore: 600 },
  );
  assert.equal(slot.start, "10:00");
  assert.equal(slot.end, "11:00");
});

test("findSlotForTask：无 notBefore 时不限制", () => {
  const slot = findSlotForTask(
    { title: "写论文", estimateMinutes: 60, date: today, fixedTime: false },
    settings,
    [],
    today,
  );
  assert.equal(slot.start, "09:00");
});
