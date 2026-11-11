// 多段任务：一条 task 可对应多个互不重叠的时间块。
import { toMinutes, toTime } from "../utils/dateTime.js";

export function splitTaskBlock(block, createId, atMinute) {
  if (!block?.id || !block.start || !block.end) return null;
  const start = toMinutes(block.start);
  const end = toMinutes(block.end);
  // 默认从中间拆，并按 5 分钟对齐；每段至少 15 分钟才有实际交互价值。
  const split = typeof atMinute === "number"
    ? Math.round(atMinute / 5) * 5
    : start + Math.round((end - start) / 10) * 5;
  if (split - start < 15 || end - split < 15) return null;

  return [
    { ...block, end: toTime(split), auto: false },
    {
      ...block,
      id: createId("block"),
      start: toTime(split),
      end: block.end,
      auto: false,
      done: false,
    },
  ];
}

export function setTaskSessionDone(tasks, blocks, blockId, done) {
  const source = blocks.find((block) => block.id === blockId);
  if (!source?.taskId || source.type === "busy") return { tasks, blocks };

  // 已完成的段转为手动固定历史，后续自动重排不会把它当作可替换的自动块。
  const nextBlocks = blocks.map((block) => block.id === blockId
    ? { ...block, done, auto: done ? false : block.auto }
    : block);
  const sessions = nextBlocks.filter((block) =>
    block.taskId === source.taskId && block.date === source.date && block.type !== "busy");
  const allSessionsDone = sessions.length > 0 && sessions.every((block) => block.done);
  const nextTasks = tasks.map((task) => task.id === source.taskId
    ? { ...task, status: done && allSessionsDone ? "done" : "open" }
    : task);
  return { tasks: nextTasks, blocks: nextBlocks };
}

export function isTaskSessionDone(block, task) {
  return Boolean(block?.done || task?.status === "done");
}

export function adjustBlockDuration(block, deltaMinutes) {
  if (!block?.start || !block?.end) return block;
  const delta = Number(deltaMinutes) || 0;
  const start = toMinutes(block.start);
  const end = Math.max(start + 15, Math.min(24 * 60, toMinutes(block.end) + delta));
  return { ...block, end: toTime(end) };
}
