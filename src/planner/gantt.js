// 目标甘特图数据：层级行与时间跨度计算。
import { addDays } from "../utils/dateTime.js";

// 甘特图数据：每个目标的时间跨度（优先取「该目标及其子目标」关联任务的日期范围，无任务则按类型从今天给默认区间），
// 按层级深度优先排成有序行，并算出整体时间轴范围（左右各留 2 天）。
export function buildGoalGantt(goals, tasks, todayStr) {
  const childrenMap = {};
  goals.forEach((g) => {
    if (g.parentId) (childrenMap[g.parentId] = childrenMap[g.parentId] || []).push(g);
  });
  const tasksByGoal = {};
  tasks.forEach((t) => {
    if (t.goalId) (tasksByGoal[t.goalId] = tasksByGoal[t.goalId] || []).push(t);
  });
  const goalMap = {};
  goals.forEach((g) => { goalMap[g.id] = g; });
  const HORIZON = { long: 84, month: 28, week: 7 };

  // 进度联动：有子目标→取子目标进度均值；否则有关联任务→完成数/总数；都没有→用户手填的 goal.progress（可拖）。
  // auto=true 表示由子项自动汇总，进度条只读、不让用户拖。
  const progMemo = {};
  function progressOf(goalId, visiting) {
    if (progMemo[goalId]) return progMemo[goalId];
    if (visiting.has(goalId)) return { value: 0, auto: false };
    visiting.add(goalId);
    const children = childrenMap[goalId] || [];
    const gtasks = tasksByGoal[goalId] || [];
    let info;
    if (children.length) {
      const sum = children.reduce((a, c) => a + progressOf(c.id, visiting).value, 0);
      info = { value: Math.round(sum / children.length), auto: true, kind: "goals", count: children.length };
    } else if (gtasks.length) {
      const done = gtasks.filter((t) => t.status === "done").length;
      info = { value: Math.round((done / gtasks.length) * 100), auto: true, kind: "tasks", count: gtasks.length };
    } else {
      info = { value: Math.max(0, Math.min(100, Number(goalMap[goalId] && goalMap[goalId].progress) || 0)), auto: false };
    }
    progMemo[goalId] = info;
    return info;
  }

  // 跨度：自身关联任务 ∪ 各子目标的跨度（父目标自动包住子目标，长期目标不再空降 84 天）；
  // 子树里有真实任务→实线(tasks)，否则虚线(type)；都没有→按类型给默认区间。
  const spanMemo = {};
  function spanOf(goalId, visiting) {
    if (spanMemo[goalId]) return spanMemo[goalId];
    if (visiting.has(goalId)) return null;
    visiting.add(goalId);
    const dates = [];
    (tasksByGoal[goalId] || []).forEach((t) => { if (/^\d{4}-\d{2}-\d{2}$/.test(t.date)) dates.push(t.date); });
    const goalObj = goalMap[goalId];
    const startDate = goalObj?.startDate && /^\d{4}-\d{2}-\d{2}$/.test(goalObj.startDate) ? goalObj.startDate : "";
    const endDate = goalObj?.endDate && /^\d{4}-\d{2}-\d{2}$/.test(goalObj.endDate) ? goalObj.endDate : "";
    if (startDate) dates.push(startDate);
    if (endDate) dates.push(endDate);
    const hasExplicit = !!(startDate || endDate);
    const childSpans = (childrenMap[goalId] || []).map((c) => spanOf(c.id, visiting)).filter(Boolean);
    const starts = dates.concat(childSpans.map((s) => s.start));
    const ends = dates.concat(childSpans.map((s) => s.end));
    let info;
    if (starts.length) {
      let start = starts[0];
      let end = ends[0];
      starts.forEach((d) => { if (d < start) start = d; });
      ends.forEach((d) => { if (d > end) end = d; });
      // 单边日期补另一边（保底 1 天宽度，避免 bar 塌缩成点）
      if (startDate && !endDate) end = addDays(startDate, 1);
      else if (endDate && !startDate) start = addDays(endDate, -1);
      const hasTasks = dates.length > 0 || childSpans.some((s) => s.derived === "tasks");
      info = { start, end, derived: hasExplicit ? "explicit" : hasTasks ? "tasks" : "type" };
    } else {
      const type = (goalMap[goalId] && goalMap[goalId].type) || "month";
      info = { start: todayStr, end: addDays(todayStr, HORIZON[type] || 28), derived: "type" };
    }
    spanMemo[goalId] = info;
    return info;
  }

  const rows = [];
  const placed = new Set();
  function place(goal, depth) {
    if (placed.has(goal.id)) return;
    placed.add(goal.id);
    rows.push({ goal, depth, span: spanOf(goal.id, new Set()), prog: progressOf(goal.id, new Set()) });
    (childrenMap[goal.id] || []).forEach((c) => place(c, depth + 1));
  }
  goals.filter((g) => g.type === "long" && !g.parentId).forEach((g) => place(g, 0));
  goals.filter((g) => g.type === "month" && !g.parentId).forEach((g) => place(g, 0));
  goals.filter((g) => g.type === "week" && !g.parentId).forEach((g) => place(g, 0));
  goals.forEach((g) => { if (!placed.has(g.id)) place(g, 0); });

  let min = null;
  let max = null;
  rows.forEach((r) => {
    if (min === null || r.span.start < min) min = r.span.start;
    if (max === null || r.span.end > max) max = r.span.end;
  });
  if (min === null) { min = todayStr; max = addDays(todayStr, 28); }
  return { rows, min: addDays(min, -2), max: addDays(max, 2) };
}
