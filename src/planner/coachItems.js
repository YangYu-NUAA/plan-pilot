// AI 访谈 / 拆解结果的条目归一化、日期推断与去重过滤。
import { uid } from "../utils/ids.js";
import { addDays, toMinutes, toTime } from "../utils/dateTime.js";
import { pinnableTimeForTitle } from "../planningSemantics.js";
import { actionToItem } from "../coachHarness.js";
import {
  goalIdentity,
  normalizeTitle,
  taskIdentity,
  titleLooksDuplicate,
  titlesReferToSameTask,
} from "./dedup.js";
import {
  defaultBusyDuration,
  estimateMinutesForTitle,
  inferDateFromText,
  parseTimeInSentence,
} from "./textExtract.js";

export function makeBreakdown(goal, draft, selectedDate) {
  if (!goal) return [];
  const outcome = draft.outcome.trim() || goal.title;
  const blocker = draft.constraints.trim();
  const suffix = blocker ? `：${blocker}` : "";

  if (goal.type === "long") {
    return [
      { kind: "goal", type: "month", title: `明确「${goal.title}」的阶段成果`, priority: "high" },
      { kind: "goal", type: "month", title: `完成一个可检查版本：${outcome}`, priority: "high" },
      { kind: "goal", type: "month", title: `处理关键依赖${suffix || "并建立推进节奏"}`, priority: "medium" },
      { kind: "goal", type: "month", title: "安排一次阶段复盘与取舍", priority: "medium" },
    ];
  }

  if (goal.type === "month") {
    return [
      { kind: "goal", type: "week", title: `本周定义完成标准：${outcome}`, priority: "high" },
      { kind: "goal", type: "week", title: "本周完成第一版可交付物", priority: "high" },
      { kind: "goal", type: "week", title: `本周解决阻碍${suffix || "或确认资源"}`, priority: "medium" },
      { kind: "goal", type: "week", title: "本周留出反馈和修订窗口", priority: "medium" },
    ];
  }

  return [
    { kind: "task", date: selectedDate, title: `写清楚完成标准：${outcome}`, estimateMinutes: 30, priority: "high" },
    { kind: "task", date: selectedDate, title: `列出依赖、风险和下一步${suffix}`, estimateMinutes: 45, priority: "medium" },
    { kind: "task", date: selectedDate, title: `完成第一段可见推进：${goal.title}`, estimateMinutes: 90, priority: "high" },
    { kind: "task", date: addDays(selectedDate, 1), title: `检查结果并调整「${goal.title}」`, estimateMinutes: 45, priority: "medium" },
  ];
}

// JSON 解析加固抽到纯模块 src/jsonExtract.js（便于单测），见 test/jsonExtract.test.mjs。

export function normalizePriority(priority) {
  return ["high", "medium", "low"].includes(priority) ? priority : "medium";
}

export function normalizeBreakdownItems(items, goal, selectedDate) {
  const expectedGoalType = goal?.type === "long" ? "month" : "week";
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      if (item.kind === "task") {
        return {
          kind: "task",
          title: String(item.title || "").trim(),
          date: /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? item.date : selectedDate,
          estimateMinutes: estimateMinutesForTitle(item.title, Math.max(10, Number(item.estimateMinutes) || 45)),
          priority: normalizePriority(item.priority),
        };
      }

      return {
        kind: "goal",
        type: ["month", "week"].includes(item.type) ? item.type : expectedGoalType,
        title: String(item.title || "").trim(),
        priority: normalizePriority(item.priority),
      };
    })
    .filter((item) => item.title);
}

export function normalizeTaskSuggestions(items, selectedDate) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      // 显式 start 字段是「执行时间」（用户/模型主动指定，例如把买票放在 16:00），直接信任、钉成固定块；
      // 只有「从标题解析出的时间」才过购票守卫——避免把车次/出发时间误当执行时间（修复购票任务给了时间仍被追问）。
      const explicitStart = /^\d{2}:\d{2}$/.test(item.start) ? item.start : "";
      const start = explicitStart || pinnableTimeForTitle(item.title, parseTimeInSentence(item.title || ""));
      return {
        id: uid("suggestion"),
        title: String(item.title || "").trim(),
        estimateMinutes: estimateMinutesForTitle(item.title, Math.max(10, Number(item.estimateMinutes) || 45)),
        priority: normalizePriority(item.priority),
        date: /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? item.date : selectedDate,
        goalId: String(item.goalId || ""),
        reason: String(item.reason || "").trim(),
        ...(start ? { fixedTime: true, fixedStart: start } : {}),
      };
    })
    .filter((item) => item.title);
}

export function collectCoachItems(result) {
  const items = Array.isArray(result?.items) ? result.items : [];
  const goals = Array.isArray(result?.goals) ? result.goals.map((item) => ({ ...item, kind: "goal" })) : [];
  const tasks = Array.isArray(result?.tasks) ? result.tasks.map((item) => ({ ...item, kind: "task" })) : [];
  const busy = Array.isArray(result?.busy)
    ? result.busy.map((item) => ({ ...item, kind: "busy" }))
    : Array.isArray(result?.busyBlocks)
      ? result.busyBlocks.map((item) => ({ ...item, kind: "busy" }))
      : [];
  // 动作 schema（harness B）：把 add_* 动作转成 item；ask/done 返回 null 被过滤。兼容旧 items 形态。
  const fromActions = Array.isArray(result?.actions) ? result.actions.map(actionToItem).filter(Boolean) : [];
  return items.concat(goals, tasks, busy, fromActions);
}

export function normalizeCoachItems(items, selectedDate) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const inferredKind = item.kind || (["long", "month", "week"].includes(item.type) ? "goal" : "task");

      if (inferredKind === "goal") {
        return {
          id: uid("coach"),
          kind: "goal",
          type: ["long", "month", "week"].includes(item.type) ? item.type : "week",
          title: String(item.title || "").trim(),
          priority: normalizePriority(item.priority),
          parentId: String(item.parentId || ""),
          parentTitle: String(item.parentTitle || item.parent || "").trim(),
          tempId: String(item.tempId || item.id || item.key || "").trim(),
        };
      }

      if (inferredKind === "busy") {
        const start = /^\d{2}:\d{2}$/.test(item.start) ? item.start : parseTimeInSentence(item.title || "");
        if (!start) return null;
        const end = /^\d{2}:\d{2}$/.test(item.end)
          ? item.end
          : toTime(toMinutes(start) + defaultBusyDuration(item.title || ""));
        return {
          id: uid("coach"),
          kind: "busy",
          title: String(item.title || "固定安排").trim(),
          date: /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? item.date : selectedDate,
          start,
          end,
        };
      }

      return {
        id: uid("coach"),
        kind: "task",
        title: String(item.title || "").trim(),
        estimateMinutes: estimateMinutesForTitle(item.title, Math.max(10, Number(item.estimateMinutes) || 45)),
        priority: normalizePriority(item.priority),
        date: inferDateFromText([item.date, item.when, item.horizon, item.scope].filter(Boolean).join(" "), selectedDate),
        goalId: String(item.goalId || ""),
        goalTitle: String(item.goalTitle || item.goal || "").trim(),
        tempId: String(item.tempId || item.id || item.key || "").trim(),
      };
    })
    .filter((item) => item?.title);
}

export function attachKnownGoalReferences(items, planner) {
  const duplicateGoalRefs = new Map();

  items.forEach((item) => {
    if (item.kind !== "goal") return;
    const existing = planner.goals.find(
      (goal) => goal.type === item.type && titleLooksDuplicate(goal.title, item.title),
    );
    if (!existing) return;
    [item.tempId, item.id, item.title, normalizeTitle(item.title)].filter(Boolean).forEach((key) => {
      duplicateGoalRefs.set(String(key), existing.id);
    });
  });

  if (!duplicateGoalRefs.size) return items;

  return items.map((item) => {
    if (item.kind !== "task") return item;
    const direct = duplicateGoalRefs.get(String(item.goalId || ""));
    const byTitle = duplicateGoalRefs.get(String(item.goalTitle || "")) || duplicateGoalRefs.get(normalizeTitle(item.goalTitle));
    return direct || byTitle ? { ...item, goalId: direct || byTitle } : item;
  });
}

export function filterCoachItems(items, planner) {
  const keptTasks = [];
  const keptGoals = [];
  const keptBusy = [];

  return items.filter((item) => {
    if (item.kind === "goal") {
      const duplicateExisting = planner.goals.some(
        (goal) => goal.type === item.type && titleLooksDuplicate(goal.title, item.title),
      );
      const duplicateNew = keptGoals.some((goal) => goal.type === item.type && titleLooksDuplicate(goal.title, item.title));
      if (duplicateExisting || duplicateNew) return false;
      keptGoals.push(item);
      return true;
    }

    if (item.kind === "busy") {
      const duplicateExisting = planner.blocks.some(
        (block) => block.date === item.date && block.type === "busy" && titleLooksDuplicate(block.title, item.title),
      );
      const duplicateNew = keptBusy.some((block) => block.date === item.date && titleLooksDuplicate(block.title, item.title));
      if (duplicateExisting || duplicateNew) return false;
      keptBusy.push(item);
      return true;
    }

    const duplicateExisting = planner.tasks.some(
      (task) => task.date === item.date && titlesReferToSameTask(task.title, item.title),
    );
    const duplicateNew = keptTasks.some(
      (task) => task.date === item.date && titlesReferToSameTask(task.title, item.title),
    );
    if (duplicateExisting || duplicateNew) return false;
    keptTasks.push(item);
    return true;
  });
}

export function filterBreakdownItems(items, planner, goal) {
  const taskKeys = new Set(planner.tasks.map(taskIdentity));
  const goalKeys = new Set(planner.goals.map(goalIdentity));
  const nextTaskKeys = new Set();
  const nextGoalKeys = new Set();

  return items.filter((item) => {
    if (item.kind === "task") {
      const key = taskIdentity(item);
      const duplicateExisting = planner.tasks.some(
        (task) => task.date === item.date && titlesReferToSameTask(task.title, item.title),
      );
      if (!normalizeTitle(item.title) || taskKeys.has(key) || nextTaskKeys.has(key) || duplicateExisting) return false;
      nextTaskKeys.add(key);
      return true;
    }

    const key = goalIdentity({ ...item, parentId: goal.id });
    if (!normalizeTitle(item.title) || goalKeys.has(key) || nextGoalKeys.has(key)) return false;
    nextGoalKeys.add(key);
    return true;
  });
}

export function filterTaskSuggestions(suggestions, existingTasks) {
  const taskKeys = new Set(existingTasks.map(taskIdentity));
  const kept = [];

  return suggestions.filter((task) => {
    const key = taskIdentity(task);
    const duplicateExisting = existingTasks.some(
      (existing) => existing.date === task.date && titlesReferToSameTask(existing.title, task.title),
    );
    const duplicateNew = kept.some(
      (existing) => existing.date === task.date && titlesReferToSameTask(existing.title, task.title),
    );
    if (!normalizeTitle(task.title) || taskKeys.has(key) || duplicateExisting || duplicateNew) return false;
    kept.push(task);
    return true;
  });
}

