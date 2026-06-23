import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  CheckSquare,
  ChevronRight,
  Clock3,
  Download,
  ListChecks,
  ListTodo,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  SkipForward,
  Send,
  Settings,
  Sparkles,
  Square,
  Target,
  Trash2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import {
  planningCoachStartMessage,
  planningCoachSystemMessages,
  TODAY_GUIDE_SYSTEM_PROMPT,
} from "./planningSkill.js";
import {
  normalizeSentence,
  isBusySentence,
  isMeetingSentence,
  isPostMeetingTask,
  isTicketPurchaseTask,
  looksLikeSingleActionItem,
  pinnableTimeForTitle,
} from "./planningSemantics.js";
import { tryExtractJson } from "./jsonExtract.js";
import { APP_NAME, APP_SHORT_NAME, STORAGE_KEY, AI_KEY_STORAGE_KEY } from "./constants/appConstants.js";
import { AI_PROVIDER_PRESETS, getAiProviderPreset } from "./constants/aiProviders.js";
import {
  priorityOrder,
  priorityLabel,
  goalTypeLabel,
  energyOptions,
  energyColorMap,
  energyColor,
} from "./constants/labels.js";

const defaultState = {
  settings: {
    workSegments: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }],
    shortBreak: 10,
    longBreak: 30,
  },
  ai: {
    enabled: true,
    provider: "deepseek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    profileLearningEnabled: false,
  },
  goals: [],
  tasks: [],
  blocks: [],
  dayPlans: {},
  reviews: [],
  recurring: [],
};

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function readLocalAiKey() {
  try {
    return localStorage.getItem(AI_KEY_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function isRecurringDerivedBlock(block) {
  return Boolean(block?.recurringDerived) || String(block?.id || "").startsWith("rec-");
}

function expandRecurringBlocks(items, existingBlocks = []) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const blocks = [];
  const today = new Date();
  const existingKeys = new Set(
    existingBlocks.map((block) => `${block.date}|${block.start}|${block.taskId || block.title || ""}`),
  );

  items.forEach((item) => {
    if (!Number.isInteger(item.dayOfWeek) || item.dayOfWeek < 0 || item.dayOfWeek > 6) return;
    const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endDate = item.endDate ? new Date(`${item.endDate}T00:00:00`) : null;
    const maxDate = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate());
    const limit = endDate && endDate < maxDate ? endDate : maxDate;

    while (cursor <= limit) {
      if (cursor.getDay() === item.dayOfWeek) {
        const date = getLocalDate(cursor);
        const key = `${date}|${item.start}|${item.taskId || item.title || ""}`;
        if (!existingKeys.has(key)) {
          blocks.push({
            id: `rec-${item.id || ""}-${date}`,
            recurringId: item.id || "",
            recurringDerived: true,
            date,
            type: "busy",
            taskId: "",
            title: item.title || "",
            start: item.start,
            end: item.end,
            auto: false,
          });
          existingKeys.add(key);
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  });

  return blocks;
}

function replaceRecurringBlocks(items, blocks = []) {
  const manualBlocks = blocks.filter((block) => !isRecurringDerivedBlock(block));
  return manualBlocks.concat(expandRecurringBlocks(items, manualBlocks));
}

function addDays(dateString, amount) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + amount);
  return getLocalDate(date);
}

function formatShortDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return `${month}月${day}日`;
}

function formatHumanDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date(year, month - 1, day));
}

function toMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function toTime(minutes) {
  const hours = `${Math.floor(minutes / 60)}`.padStart(2, "0");
  const mins = `${minutes % 60}`.padStart(2, "0");
  return `${hours}:${mins}`;
}

function duration(start, end) {
  return Math.max(0, toMinutes(end) - toMinutes(start));
}

function sum(values) {
  return values.reduce((total, item) => total + item, 0);
}

function fieldValue(form, name, fallback = "") {
  return form?.elements?.[name]?.value ?? fallback;
}

function hydrateState(input) {
  return {
    ...defaultState,
    ...input,
    settings: {
      ...defaultState.settings,
      ...(input?.settings || {}),
      // backward compat: convert old workStart/workEnd to workSegments
      workSegments: input?.settings?.workSegments ||
        (input?.settings?.workStart ? [{ start: input.settings.workStart, end: input.settings.workEnd || "18:00" }] : defaultState.settings.workSegments),
      shortBreak: input?.settings?.shortBreak ?? input?.settings?.breakMinutes ?? defaultState.settings.shortBreak,
      longBreak: input?.settings?.longBreak ?? defaultState.settings.longBreak,
    },
    ai: (() => {
      const ai = { ...defaultState.ai, ...(input?.ai || {}) };
      delete ai.apiKey;
      return ai;
    })(),
    goals: Array.isArray(input?.goals)
      ? input.goals.map((g) => ({ progress: 0, ...g }))
      : [],
    tasks: mergeDuplicateTasks(Array.isArray(input?.tasks) ? input.tasks : []),
    blocks: replaceRecurringBlocks(
      Array.isArray(input?.recurring) ? input.recurring : [],
      Array.isArray(input?.blocks) ? input.blocks : [],
    ),
    dayPlans: input?.dayPlans && typeof input.dayPlans === "object" ? input.dayPlans : {},
    reviews: Array.isArray(input?.reviews) ? input.reviews : [],
    recurring: Array.isArray(input?.recurring) ? input.recurring : (defaultState.recurring || []),
  };
}

function makeBreakdown(goal, draft, selectedDate) {
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

function normalizePriority(priority) {
  return ["high", "medium", "low"].includes(priority) ? priority : "medium";
}

function estimateMinutesForTitle(title, fallback = 45) {
  const text = String(title || "");
  let estimate = Number(fallback) || 45;

  if (/整理|总结|纪要|复盘|行动项|后续|待办|要点/.test(text) && /会|会议|讨论|探讨|汇报|组会|研讨/.test(text)) {
    return Math.min(Math.max(estimate, 60), 90);
  }
  if (/初步设计|框架设计|方案设计|课题设计|研究设计|系统设计|方法设计|技术路线|整体方案|架构设计/.test(text)) {
    estimate = Math.max(estimate, 180);
  }
  if (/研究|论文|基金|申请|课题|项目|产品|系统|平台|课程|报告/.test(text) && /设计|方案|框架|定义|目标/.test(text)) {
    estimate = Math.max(estimate, 180);
  }
  if (/撰写|写作|修改|整合|相关工作|文献|调研/.test(text)) {
    estimate = Math.max(estimate, 120);
  }
  if (/会议|开会|课题会|组会|研讨会|汇报|会谈/.test(text)) {
    estimate = Math.max(estimate, 60);
  }
  if (/打印|复印|扫描/.test(text)) {
    estimate = Math.min(Math.max(estimate, 15), 30);
  }
  if (/购买|买票|订票|查票|回复|发送/.test(text)) {
    estimate = Math.min(Math.max(estimate, 10), 30);
  }

  return estimate;
}

function normalizeBreakdownItems(items, goal, selectedDate) {
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

function normalizeTaskSuggestions(items, selectedDate) {
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

function nextWeekday(dateString, targetDay) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const current = date.getDay();
  let delta = (targetDay - current + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(dateString, delta);
}

function inferDateFromText(value, selectedDate) {
  const text = String(value || "").toLowerCase();
  const absolute = text.match(/\d{4}-\d{2}-\d{2}/);
  if (absolute) return absolute[0];
  if (/明天|tomorrow/.test(text)) return addDays(selectedDate, 1);
  if (/后天/.test(text)) return addDays(selectedDate, 2);
  if (/下周一|next monday/.test(text)) return nextWeekday(selectedDate, 1);
  if (/下周二|next tuesday/.test(text)) return nextWeekday(selectedDate, 2);
  if (/下周三|next wednesday/.test(text)) return nextWeekday(selectedDate, 3);
  if (/下周四|next thursday/.test(text)) return nextWeekday(selectedDate, 4);
  if (/下周五|next friday/.test(text)) return nextWeekday(selectedDate, 5);
  if (/下周六|next saturday/.test(text)) return nextWeekday(selectedDate, 6);
  if (/下周日|下周天|next sunday/.test(text)) return nextWeekday(selectedDate, 0);
  if (/下周|next week/.test(text)) return nextWeekday(selectedDate, 1);
  return selectedDate;
}

function collectCoachItems(result) {
  const items = Array.isArray(result?.items) ? result.items : [];
  const goals = Array.isArray(result?.goals) ? result.goals.map((item) => ({ ...item, kind: "goal" })) : [];
  const tasks = Array.isArray(result?.tasks) ? result.tasks.map((item) => ({ ...item, kind: "task" })) : [];
  const busy = Array.isArray(result?.busy)
    ? result.busy.map((item) => ({ ...item, kind: "busy" }))
    : Array.isArray(result?.busyBlocks)
      ? result.busyBlocks.map((item) => ({ ...item, kind: "busy" }))
      : [];
  return items.concat(goals, tasks, busy);
}

function normalizeCoachItems(items, selectedDate) {
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

function titleBigrams(title) {
  const compact = normalizeTitle(title).replace(/[^\u4e00-\u9fa5a-z0-9]/g, "");
  if (compact.length <= 1) return compact ? [compact] : [];
  const grams = [];
  for (let index = 0; index < compact.length - 1; index += 1) {
    grams.push(compact.slice(index, index + 2));
  }
  return grams;
}

function titleLooksDuplicate(a, b) {
  const left = normalizeTitle(a).replace(/[^\u4e00-\u9fa5a-z0-9]/g, "");
  const right = normalizeTitle(b).replace(/[^\u4e00-\u9fa5a-z0-9]/g, "");
  if (!left || !right) return false;
  if (left === right) return true;
  if (Math.min(left.length, right.length) >= 8 && (left.includes(right) || right.includes(left))) return true;

  const aGrams = new Set(titleBigrams(a));
  const bGrams = new Set(titleBigrams(b));
  if (!aGrams.size || !bGrams.size) return false;
  const smallerSize = Math.min(aGrams.size, bGrams.size);
  // Require higher overlap for very short titles (few unique bigrams)
  const threshold = smallerSize < 4 ? 0.95 : 0.78;
  const overlap = [...aGrams].filter((gram) => bGrams.has(gram)).length;
  return overlap / smallerSize >= threshold;
}

function titlesReferToSameTask(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  const leftNumbers = left.match(/\d+(?:[.:]\d+)?/g) || [];
  const rightNumbers = right.match(/\d+(?:[.:]\d+)?/g) || [];
  if (leftNumbers.length && rightNumbers.length && leftNumbers.join("|") !== rightNumbers.join("|")) return false;
  return titleLooksDuplicate(left, right);
}

function compactPlannerTasks(tasks, blocks) {
  const tasksWithoutBusyCommitments = tasks.filter(
    (task) =>
      !(
        (task.fixedTime || task.kind === "fixed") &&
        blocks.some(
          (block) =>
            block.type === "busy" &&
            block.date === task.date &&
            titlesReferToSameTask(block.title, task.title),
        )
      ),
  );
  const { tasks: compactedTasks, canonicalIdByTaskId } = compactTaskList(tasksWithoutBusyCommitments);
  const taskById = Object.fromEntries(compactedTasks.map((task) => [task.id, task]));
  const migratedBlocks = blocks
    .map((block) => {
      const canonicalTaskId = block.taskId ? canonicalIdByTaskId.get(block.taskId) : "";
      return canonicalTaskId && canonicalTaskId !== block.taskId ? { ...block, taskId: canonicalTaskId } : block;
    })
    .filter((block) => !block.taskId || Boolean(taskById[block.taskId]));
  const compactedBlocks = [];

  migratedBlocks.forEach((block) => {
    if (!block.taskId) {
      compactedBlocks.push(block);
      return;
    }

    const task = taskById[block.taskId];
    const duplicateIndex = compactedBlocks.findIndex((existing) => {
      if (!existing.taskId || existing.date !== block.date) return false;
      const existingTask = taskById[existing.taskId];
      const sameTask = existing.taskId === block.taskId || titlesReferToSameTask(existingTask?.title, task?.title);
      return sameTask && overlapsAny(existing, block);
    });

    if (duplicateIndex < 0) {
      compactedBlocks.push(block);
      return;
    }

    const previous = compactedBlocks[duplicateIndex];
    if (previous.auto && !block.auto) compactedBlocks[duplicateIndex] = block;
  });

  return { tasks: compactedTasks, blocks: compactedBlocks };
}

function attachKnownGoalReferences(items, planner) {
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

function filterCoachItems(items, planner) {
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

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[\s，。！？、,.!?;；:："'"''（）()[\]【】《》<>-]/g, "")
    .trim();
}

function taskIdentity(task) {
  return `${task.date || ""}|${normalizeTitle(task.title)}`;
}

function goalIdentity(goal) {
  return `${goal.parentId || ""}|${goal.type || ""}|${normalizeTitle(goal.title)}`;
}

function mergeTaskFields(previous, current) {
  const previousIsManual = !previous.goalId;
  const currentIsManual = !current.goalId;
  const shouldPreferCurrent =
    (!previousIsManual && currentIsManual) ||
    (previous.status !== "done" && current.status === "done") ||
    (previous.createdAt && current.createdAt && current.createdAt < previous.createdAt && previousIsManual === currentIsManual);
  const preferred = shouldPreferCurrent ? current : previous;
  const fallback = shouldPreferCurrent ? previous : current;

  return {
    ...fallback,
    ...preferred,
    id: previous.id,
    goalId: preferred.goalId || fallback.goalId || "",
    status: previous.status === "done" || current.status === "done" ? "done" : preferred.status,
  };
}

function compactTaskList(tasks) {
  const compacted = [];
  const canonicalIdByTaskId = new Map();

  tasks.forEach((task) => {
    if (!normalizeTitle(task.title)) return;
    const duplicateIndex = compacted.findIndex(
      (existing) => existing.date === task.date && titlesReferToSameTask(existing.title, task.title),
    );

    if (duplicateIndex < 0) {
      compacted.push(task);
      canonicalIdByTaskId.set(task.id, task.id);
      return;
    }

    const canonical = compacted[duplicateIndex];
    compacted[duplicateIndex] = mergeTaskFields(canonical, task);
    canonicalIdByTaskId.set(task.id, canonical.id);
  });

  return { tasks: compacted, canonicalIdByTaskId };
}

function mergeDuplicateTasks(tasks) {
  return compactTaskList(tasks).tasks;
}

function filterBreakdownItems(items, planner, goal) {
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

function filterTaskSuggestions(suggestions, existingTasks) {
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

function defaultBusyDuration(sentence) {
  if (/监考|考试/.test(sentence)) return 120;
  if (/火车|高铁|航班|出发|前往|返回|通勤/.test(sentence)) return 120;
  return 60;
}

// 句子分类、抽取闸门、购票时间守卫已移至 ./planningSemantics.js（可被 node --test 独立测试）。

function hasSharedPlanningObject(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  const anchors = ["项目", "文档", "材料", "课题", "申请", "报告", "子章节", "文献", "框架", "初稿", "火车", "高铁", "车票"];
  if (anchors.some((word) => left.includes(word) && right.includes(word))) return true;

  const leftTokens = left.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  return leftTokens.some((token) => token.length >= 3 && right.includes(token));
}

function shouldScheduleBefore(first, second) {
  const a = String(first?.title || "");
  const b = String(second?.title || "");

  if (/打印|复印/.test(a) && /扫描|上传|提交/.test(b) && hasSharedPlanningObject(a, b)) return true;
  if (/扫描/.test(a) && /上传|提交/.test(b) && hasSharedPlanningObject(a, b)) return true;
  if (/整理|梳理|确定|大纲|框架|核心观点/.test(a) && /撰写|写作|初稿/.test(b) && hasSharedPlanningObject(a, b)) return true;
  if (isTicketPurchaseTask(a) && /出发|前往|返回|乘车|赶车/.test(b)) return true;

  return false;
}

function scheduleUrgencyScore(task) {
  const title = String(task?.title || "");
  let score = 0;
  if (isTicketPurchaseTask(title) && /今天|下午|晚上|火车|高铁|航班/.test(title)) score += 5;
  if (/提交|上传|打印|扫描|发送/.test(title)) score += 1;
  if (/准备|确认/.test(title)) score += 0.5;
  return score;
}

function compareTasksForScheduling(a, b) {
  if (shouldScheduleBefore(a, b)) return -1;
  if (shouldScheduleBefore(b, a)) return 1;

  const urgencyDelta = scheduleUrgencyScore(b) - scheduleUrgencyScore(a);
  if (urgencyDelta !== 0) return urgencyDelta;

  const priorityDelta = priorityOrder[b.priority] - priorityOrder[a.priority];
  if (priorityDelta !== 0) return priorityDelta;

  return Number(a.estimateMinutes || 0) - Number(b.estimateMinutes || 0);
}

function latestMeetingEnd(blocks) {
  const meetingBlocks = blocks.filter((block) => block.type === "busy" && isMeetingSentence(block.title || ""));
  if (!meetingBlocks.length) return null;
  return Math.max(...meetingBlocks.map((block) => toMinutes(block.end)));
}

function meetingEndForTask(taskTitle, blocks) {
  const meetingBlocks = blocks.filter((block) => block.type === "busy" && isMeetingSentence(block.title || ""));
  if (!meetingBlocks.length) return null;

  const title = String(taskTitle || "");
  const related = meetingBlocks.filter((block) => hasSharedPlanningObject(title, block.title));

  return Math.max(...(related.length ? related : meetingBlocks).map((block) => toMinutes(block.end)));
}

function parseChineseNumber(value) {
  const text = String(value || "");
  if (/^\d+$/.test(text)) return Number(text);

  const digits = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const tenIndex = text.indexOf("十");
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : digits[text.slice(0, tenIndex)];
    const onesText = text.slice(tenIndex + 1);
    const ones = onesText ? digits[onesText] : 0;
    return Number.isInteger(tens) && Number.isInteger(ones) ? tens * 10 + ones : NaN;
  }

  const parsed = [...text].map((character) => digits[character]);
  return parsed.length && parsed.every(Number.isInteger) ? Number(parsed.join("")) : NaN;
}

function parseTimeInSentence(sentence) {
  const matches = String(sentence || "").matchAll(
    /(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*([:：.点时])?\s*(半|一刻|三刻)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})?\s*(?:分)?/g,
  );

  for (const match of matches) {
    const marker = match[1] || "";
    const separator = match[3] || "";
    let hour = parseChineseNumber(match[2]);
    let minute = match[5] ? parseChineseNumber(match[5]) : 0;
    if (match[4] === "半") minute = 30;
    if (match[4] === "一刻") minute = 15;
    if (match[4] === "三刻") minute = 45;

    if (!marker && !separator) continue;
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) continue;
    if (/下午|傍晚|晚上/.test(marker) && hour < 12) hour += 12;
    if (marker === "中午" && hour < 11) hour += 12;

    return toTime(hour * 60 + minute);
  }

  return null;
}

function extractBusyBlocksFromText(text, date, existingBlocks = []) {
  const existingKeys = new Set(
    existingBlocks
      .filter((block) => block.date === date && block.type === "busy")
      .map((block) => `${block.start}|${normalizeTitle(block.title)}`),
  );

  return String(text || "")
    .split(/[\n。；;]/)
    .map(normalizeSentence)
    .filter((sentence) => sentence && isBusySentence(sentence) && looksLikeSingleActionItem(sentence))
    .map((sentence) => {
      const start = parseTimeInSentence(sentence);
      if (!start) return null;
      const end = toTime(toMinutes(start) + defaultBusyDuration(sentence));
      return {
        id: uid("block"),
        date,
        type: "busy",
        taskId: "",
        title: sentence,
        start,
        end,
        auto: false,
      };
    })
    .filter(Boolean)
    .filter((block) => {
      const key = `${block.start}|${normalizeTitle(block.title)}`;
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });
}

function extractCoachBusyItemsFromText(text, selectedDate, existingBlocks = []) {
  const recoveredBlocks = [];

  String(text || "")
    .split(/[\n。；;]/)
    .map(normalizeSentence)
    .filter(Boolean)
    .forEach((sentence) => {
      const date = inferDateFromText(sentence, selectedDate);
      extractBusyBlocksFromText(sentence, date, existingBlocks.concat(recoveredBlocks)).forEach((block) => {
        recoveredBlocks.push(block);
      });
    });

  return recoveredBlocks.map((block) => ({
    kind: "busy",
    title: block.title,
    date: block.date,
    start: block.start,
    end: block.end,
  }));
}

function toBusyBlocks(items) {
  return items.map((item) => ({
    id: uid("block"),
    date: item.date,
    type: "busy",
    taskId: "",
    title: item.title,
    start: item.start,
    end: item.end,
    auto: false,
  }));
}

function recoverBusyBlocksFromPlanningContext(text, selectedDate, existingBlocks = []) {
  return toBusyBlocks(extractCoachBusyItemsFromText(text, selectedDate, existingBlocks));
}

function mergeUniqueBusyBlocks(existingBlocks, recoveredBlocks) {
  const merged = [...existingBlocks];

  recoveredBlocks.forEach((candidate) => {
    const duplicate = merged.some(
      (block) =>
        block.type === "busy" &&
        block.date === candidate.date &&
        block.start === candidate.start &&
        titleLooksDuplicate(block.title, candidate.title),
    );
    if (!duplicate) merged.push(candidate);
  });

  return merged;
}

function extractTimedTasksFromText(text, date, existingTasks = []) {
  const existingKeys = new Set(existingTasks.map(taskIdentity));

  return String(text || "")
    .split(/[\n。；;]/)
    .map(normalizeSentence)
    .filter((sentence) => sentence && isMeetingSentence(sentence) && parseTimeInSentence(sentence))
    .map((sentence) => ({
      id: uid("task"),
      title: sentence,
      estimateMinutes: defaultBusyDuration(sentence),
      priority: "high",
      goalId: "",
      date,
      status: "open",
      fixedTime: true,
      createdAt: new Date().toISOString(),
    }))
    .filter((task) => {
      const key = taskIdentity(task);
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });
}

function isMorningActionSentence(sentence) {
  if (!sentence) return false;
  if (isMeetingSentence(sentence) && parseTimeInSentence(sentence)) return false;
  if (isBusySentence(sentence) && parseTimeInSentence(sentence)) return false;
  if (isPostMeetingTask(sentence)) return true;
  if (/会议|开会|课题会|组会|例会|研讨会|监考|考试|上课|答辩|面试/.test(sentence)) return false;
  if (/购买|买票|订票|预订|查票|抢票|打印|复印|扫描|提交|发送|完成|修改|撰写|整理|准备|确认|联系|回复|阅读|调研|查看|检查|申请|下载|上传|填写/.test(sentence)) {
    return true;
  }
  return false;
}

function extractActionTasksFromText(text, date, existingTasks = []) {
  const existingKeys = new Set(existingTasks.map(taskIdentity));

  return String(text || "")
    .split(/[\n。；;]/)
    .map(normalizeSentence)
    .filter((sentence) => isMorningActionSentence(sentence) && looksLikeSingleActionItem(sentence))
    .map((sentence) => {
      // 动作型句子若带明确时钟时间，视为「固定时间任务」，排期时钉到该时间点；否则为浮动任务，填充空档。
      // 购票任务除外：标题里的时间是车次/出发时间，不能据此钉定执行时间（pinnableTimeForTitle 会返回空）。
      const start = pinnableTimeForTitle(sentence, parseTimeInSentence(sentence));
      return {
        id: uid("task"),
        title: sentence,
        estimateMinutes: estimateMinutesForTitle(sentence, 45),
        priority: start ? "high" : "medium",
        goalId: "",
        date,
        status: "open",
        ...(start ? { fixedTime: true, fixedStart: start } : {}),
        createdAt: new Date().toISOString(),
      };
    })
    .filter((task) => {
      const key = taskIdentity(task);
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });
}

async function callPlanningAi({ ai, messages, maxTokens = 1800, json = true, serverKeyOk = false }) {
  // 浏览器 + 服务端都没 Key 时直接抛错，避免触发 400 网络请求。
  // serverKeyOk 由调用方根据 mount 时 /api/ai/status 的查询结果传入。
  const apiKey = ai.apiKey || readLocalAiKey() || undefined;
  if (!apiKey && !serverKeyOk) {
    throw new Error("未配置 API Key。请在设置中添加浏览器 Key，或检查服务端环境变量（AI_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY）。");
  }
  // 推理型模型（step-3.7-flash 等）会把 token 预算先花在「思考」(message.reasoning) 上，
  // 预算太小会在写正文前就被 finish_reason=length 截断、content 为空。
  // 所以 JSON 模式给一个较高的下限，保证「想完还能把 JSON 写出来」。非推理模型用不满，不会涨成本。
  const effectiveMax = json ? Math.max(maxTokens, 5000) : maxTokens;
  // 单次调用：jsonMode=是否启用严格 json_object（弱模型常因此返回空）；extra=追加的纠正消息
  async function once(jsonMode, extra) {
    const response = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: ai.provider,
        protocol: ai.protocol || "openai-compatible",
        baseUrl: ai.baseUrl,
        model: ai.model,
        apiKey,
        messages: extra ? messages.concat(extra) : messages,
        max_tokens: effectiveMax,
        temperature: 0.2,
        ...(jsonMode && json ? { response_format: { type: "json_object" } } : {}),
        ...(ai.provider === "deepseek" ? { thinking: { type: "disabled" } } : {}),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.error || "AI 调用失败。");
    const top = data.choices?.[0] || {};
    const choice = top.message || {};
    let content = choice.content ?? choice.reasoning_content ?? "";
    if (Array.isArray(content)) {
      content = content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
    }
    content = String(content || "").trim();
    // 推理模型把预算用光、还没写正文：给出准确报错，而不是误判成「JSON 格式错误」
    if (!content && top.finish_reason === "length") {
      throw new Error("模型把 token 预算都用在思考上、正文被截断（finish_reason=length）。请调大 max_tokens，或在模型侧关闭推理模式。");
    }
    return content;
  }

  if (!json) {
    const content = await once(false);
    return tryExtractJson(content) || { message: content, items: [] };
  }

  // JSON 模式：生成 → 校验 → 修复，逐步降级，最多 3 次，让弱模型也能稳定吐 JSON
  const tries = [
    () => once(true),
    () => once(false, [{ role: "user", content: "请只返回一个 JSON 对象：不要 Markdown 代码块、不要任何解释或前后缀，必须以 { 开头、以 } 结尾。" }]),
    () => once(false, [{ role: "user", content: "上一条没有给出合法 JSON。现在只输出修正后的纯 JSON 对象，开头是 {、结尾是 }，其余一律不要。" }]),
  ];
  let lastError = null;
  for (const run of tries) {
    let content = "";
    try {
      content = await run();
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!content) {
      lastError = new Error("AI 没有返回可用内容。");
      continue;
    }
    const parsed = tryExtractJson(content);
    if (parsed) return parsed;
    lastError = new Error("AI 返回的不是有效 JSON。");
  }
  throw new Error(`${lastError?.message || "AI 调用失败"}（已自动重试，仍未拿到可用 JSON；可换更稳的模型如 DeepSeek）。`);
}

function usePlannerStore() {
  const [state, setState] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? hydrateState(JSON.parse(raw)) : defaultState;
    } catch {
      return defaultState;
    }
  });
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef(null);

  // load from file on mount — file is the source of truth, but don't wipe localStorage on first upgrade
  useEffect(() => {
    fetch("/api/data")
      .then((r) => r.json())
      .then((fileData) => {
        if (fileData && !fileData.error) {
          const hasContent =
            (Array.isArray(fileData.tasks) && fileData.tasks.length > 0) ||
            (Array.isArray(fileData.blocks) && fileData.blocks.length > 0) ||
            (Array.isArray(fileData.goals) && fileData.goals.length > 0) ||
            (fileData.dayPlans != null && typeof fileData.dayPlans === "object" && Object.keys(fileData.dayPlans).length > 0) ||
            (Array.isArray(fileData.reviews) && fileData.reviews.length > 0) ||
            (Array.isArray(fileData.recurring) && fileData.recurring.length > 0) ||
            (fileData.settings != null && typeof fileData.settings === "object" && Object.keys(fileData.settings).length > 0) ||
            (fileData.ai != null && typeof fileData.ai === "object" && Object.keys(fileData.ai).length > 0);
          if (hasContent) {
            const merged = hydrateState(fileData);
            setState(merged);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
          } else {
            // Server is empty — push current localStorage state to seed the file store
            const localRaw = localStorage.getItem(STORAGE_KEY);
            if (localRaw) {
              fetch("/api/data", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: localRaw,
              }).catch(() => {});
            }
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  // compact tasks/blocks on mount and after data load
  useEffect(() => {
    setState((current) => {
      const compacted = compactPlannerTasks(current.tasks, current.blocks);
      const tasksChanged = compacted.tasks.length !== current.tasks.length;
      const blocksChanged =
        compacted.blocks.length !== current.blocks.length ||
        compacted.blocks.some((block, index) => block !== current.blocks[index]);
      return tasksChanged || blocksChanged ? { ...current, ...compacted } : current;
    });
  }, [loaded]);

  // save to localStorage immediately, debounce to file
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { console.error("localStorage write failed:", e); }
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      }).catch(() => {});
    }, 2000);
    return () => clearTimeout(saveTimer.current); // 卸载/重渲染时清理待写定时器 —— from PR #6 (hrjtju)
  }, [state, loaded]);

  return [state, setState];
}

function sortBlocks(blocks) {
  return [...blocks].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
}

// Greedy lane assignment for overlapping blocks. Each block gets a `_col`
// (its lane index) and `_totalCols` (number of lanes in its overlap cluster)
// so the timeline can render them side-by-side instead of stacking on top.
//
// Complexity: O(n log n) for the sort, O(n × max_overlap) for the sweep.
// In practice max_overlap is bounded by daily schedule density (~3-5),
// so this is effectively O(n). The naive alternative recomputing totalCols
// per block via a full filter would be O(n²).
function assignTimelineColumns(blocks) {
  const sorted = [...blocks]
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
    .map((b) => ({ ...b }));
  const active = []; // { block, endMin } — blocks still overlapping with current

  for (const block of sorted) {
    const startMin = toMinutes(block.start);
    // Drop blocks that ended before this one started.
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].endMin <= startMin) active.splice(i, 1);
    }
    // Pick smallest free lane among currently-active blocks.
    const usedCols = new Set(active.map((a) => a.block._col));
    let col = 0;
    while (usedCols.has(col)) col++;
    block._col = col;
    // Compute shared totalCols = max lane index used by this block's cluster.
    let maxCol = col;
    for (const a of active) if (a.block._col > maxCol) maxCol = a.block._col;
    const totalCols = maxCol + 1;
    block._totalCols = totalCols;
    // All active blocks share the same cluster → same totalCols.
    for (const a of active) a.block._totalCols = totalCols;
    active.push({ block, endMin: toMinutes(block.end) });
  }

  return sorted;
}

function getProtectedBreaks(settings) {
  // find midday gaps >30min between work segments
  const segs = settings.workSegments || [];
  const breaks = [];
  for (let i = 0; i < segs.length - 1; i++) {
    const gapStart = segs[i].end;
    const gapEnd = segs[i + 1].start;
    if (toMinutes(gapEnd) - toMinutes(gapStart) >= 30) {
      breaks.push({ start: gapStart, end: gapEnd, title: "休息" });
    }
  }
  return breaks;
}

function polishAiBlocks(blocks, segments) {
  if (!blocks.length || !segments.length) return blocks;
  const MIN_KEEP = 10;

  // detect split pairs: blocks sharing same taskId or title with -A/-B/-I/-II suffix
  const getBase = (title) => (title || "").replace(/[-_][ABIII]+$/, "").trim();
  const result = blocks.map((b) => ({ ...b }));

  for (let i = 0; i < result.length - 1; i++) {
    const a = result[i];
    const b = result[i + 1];
    if (a._drop || b._drop) continue;
    const sameTask = a.taskId && a.taskId === b.taskId;
    const sameBase = getBase(a.title) === getBase(b.title) && a.title !== b.title;
    if (!sameTask && !sameBase) continue;

    const aDur = toMinutes(a.end) - toMinutes(a.start);
    const bDur = toMinutes(b.end) - toMinutes(b.start);

    if (aDur < MIN_KEEP) {
      a._drop = true;
      b.start = a.start;
    }
    if (bDur < MIN_KEEP) {
      b._drop = true;
      if (!a._drop) a.end = b.end;
    }
  }

  // last segment tail: check if block near end of last segment
  const lastSeg = segments[segments.length - 1];
  const lastSegEnd = toMinutes(lastSeg.end);
  for (let i = result.length - 1; i >= 0; i--) {
    const b = result[i];
    if (b._drop) continue;
    const bEnd = toMinutes(b.end);
    const bDur = bEnd - toMinutes(b.start);
    if (bEnd <= lastSegEnd) {
      const remaining = lastSegEnd - bEnd;
      if (remaining > 0 && remaining < bDur) {
        // task ended, but the remaining gap after it is too small for the same task
        // → leave as-is, AI already handled
      }
    }
    break; // only check last block
  }

  // Safety net: even with the HARD BOUNDARY RULE in the prompt, AI may still
  // emit blocks outside work segments (weak models, temperature drift, JSON
  // truncation). Force-clamp start/end into the nearest segment and drop
  // anything that collapses below 5 min — those are too short to render or
  // interact with meaningfully.
  return clampToSegments(result, segments);
}

// Force every block to lie strictly within one of `segments`. Blocks that
// don't fit are clamped (start/end pulled into the nearest segment that
// contains the midpoint); if a block has no overlap with any segment, it's
// dropped. Blocks shorter than MIN_BLOCK_MIN after clamping are also dropped.
function clampToSegments(blocks, segments) {
  const MIN_BLOCK_MIN = 5;
  if (!segments.length) return blocks.filter(() => false);
  const segRanges = segments.map((s) => ({ start: toMinutes(s.start), end: toMinutes(s.end) }));

  return blocks
    .filter((b) => b && b.start && b.end)
    .map((b) => {
      const sMin = toMinutes(b.start);
      const eMin = toMinutes(b.end);
      if (eMin <= sMin) return { ...b, _drop: true };
      // Find segment containing the block midpoint, or nearest one.
      const mid = (sMin + eMin) / 2;
      let seg = segRanges.find((s) => mid >= s.start && mid <= s.end);
      if (!seg) {
        // Pick nearest segment by midpoint distance.
        let best = segRanges[0];
        let bestDist = Math.abs(mid - (best.start + best.end) / 2);
        for (const s of segRanges) {
          const d = Math.abs(mid - (s.start + s.end) / 2);
          if (d < bestDist) { best = s; bestDist = d; }
        }
        seg = best;
      }
      const newStart = Math.max(sMin, seg.start);
      const newEnd = Math.min(eMin, seg.end);
      const newDur = newEnd - newStart;
      if (newDur < MIN_BLOCK_MIN) return { ...b, _drop: true };
      return { ...b, start: toTime(newStart), end: toTime(newEnd) };
    });
}

function workloadMinutes(settings) {
  return (settings.workSegments || []).reduce((sum, seg) => sum + duration(seg.start, seg.end), 0);
}

function getFreeIntervals(settings, fixedBlocks, options = {}) {
  const segments = settings.workSegments || [];
  if (!segments.length) return [];
  const fixed = sortBlocks(fixedBlocks).map((block) => ({
    start: toMinutes(block.start),
    end: toMinutes(block.end),
  }));
  const intervals = [];

  segments.forEach((seg) => {
    const segStart = toMinutes(seg.start);
    const segEnd = toMinutes(seg.end);
    let cursor = segStart;

    fixed.forEach((block) => {
      if (block.end <= segStart || block.start >= segEnd) return;
      if (block.start > cursor && block.start < segEnd) {
        intervals.push({ start: cursor, end: Math.min(block.start, segEnd), segment: seg });
      }
      cursor = Math.max(cursor, Math.min(block.end, segEnd));
    });

    if (cursor < segEnd) {
      intervals.push({ start: cursor, end: segEnd, segment: seg });
    }
  });

  return intervals.filter((interval) => interval.end > interval.start);
}

function overlapsAny(block, blocks) {
  if (!Array.isArray(blocks)) return false;
  const start = toMinutes(block.start);
  const end = toMinutes(block.end);
  return blocks.some((item) => start < toMinutes(item.end) && end > toMinutes(item.start));
}

function reconcileScheduleBlocks(blocks, settings, selectedDate) {
  const protectedBreaks = getProtectedBreaks(settings);
  const todayBlocks = sortBlocks(blocks.filter((block) => block.date === selectedDate));
  const busyBlocks = todayBlocks.filter((block) => block.type === "busy");
  const taskBlocks = todayBlocks.filter((block) => block.type !== "busy");
  const removedBlockIds = new Set();
  const removedTaskIds = new Set();

  function remove(block) {
    removedBlockIds.add(block.id);
    if (block.taskId) removedTaskIds.add(block.taskId);
  }

  taskBlocks.forEach((block) => {
    if (!isInsideWorkWindow(block, settings) || overlapsAny(block, protectedBreaks) || overlapsAny(block, busyBlocks)) {
      remove(block);
    }
  });

  taskBlocks.forEach((block, index) => {
    if (removedBlockIds.has(block.id)) return;
    taskBlocks.slice(index + 1).forEach((candidate) => {
      if (removedBlockIds.has(candidate.id) || !overlapsAny(block, [candidate])) return;
      remove(block);
      remove(candidate);
    });
  });

  return {
    blocks: blocks.filter((block) => !removedBlockIds.has(block.id)),
    removedTaskIds: [...removedTaskIds],
  };
}

function isInsideWorkWindow(block, settings) {
  const segs = settings.workSegments || [];
  return segs.some((seg) => toMinutes(block.start) >= toMinutes(seg.start) && toMinutes(block.end) <= toMinutes(seg.end));
}

function isBlockInsideIntervals(block, intervals) {
  const start = toMinutes(block.start);
  const end = toMinutes(block.end);
  return intervals.some((interval) => start >= interval.start && end <= interval.end);
}

function normalizeScheduleQuestions(items, taskById) {
  const questions = (Array.isArray(items) ? items : [])
    .map((item) => ({
      id: uid("schedule-question"),
      taskId: String(item.taskId || ""),
      title: String(item.title || taskById[item.taskId]?.title || "需要确认的任务").trim(),
      estimateMinutes: Number(item.estimateMinutes || taskById[item.taskId]?.estimateMinutes || 30),
      reason: String(item.reason || "AI 不确定应该把它放在哪里。").trim(),
      hint: String(item.hint || "请补充时间约束，或在下方手动安排。").trim(),
    }))
    .filter((item) => item.title);

  return questions.filter(
    (item, index) =>
      questions.findIndex(
        (candidate) =>
          (item.taskId && candidate.taskId === item.taskId) ||
          (!item.taskId && !candidate.taskId && titlesReferToSameTask(candidate.title, item.title)),
      ) === index,
  );
}

function normalizeAiScheduleResult(result, { tasks, existingBlocks, settings, selectedDate }) {
  const todayBlocks = existingBlocks.filter((block) => block.date === selectedDate);
  const manualBlocks = todayBlocks.filter((block) => !block.auto);
  // 固定时间任务先钉到指定时间点，作为 AI 浮动排期的硬约束。
  const pinned = buildFixedTimeBlocks(tasks, settings, manualBlocks, selectedDate);
  const intervals = getFreeIntervals(settings, manualBlocks.concat(pinned.blocks));
  const adjustmentsByTaskId = new Map(
    (Array.isArray(result?.taskAdjustments) ? result.taskAdjustments : [])
      .filter((item) => item?.taskId)
      .map((item) => [String(item.taskId), item]),
  );
  const adjustedTasks = tasks.map((task) => {
    const adjustment = adjustmentsByTaskId.get(task.id);
    if (!adjustment) return task;
    const estimateMinutes = estimateMinutesForTitle(
      task.title,
      Math.max(10, Math.min(480, Number(adjustment.estimateMinutes) || task.estimateMinutes || 30)),
    );
    return estimateMinutes === Number(task.estimateMinutes) ? task : { ...task, estimateMinutes };
  });
  const taskById = Object.fromEntries(adjustedTasks.map((task) => [task.id, task]));
  const scheduledTaskIds = new Set(manualBlocks.map((block) => block.taskId).filter(Boolean));
  const autoBlocks = [];
  let questions = normalizeScheduleQuestions(result?.questions, taskById);

  (Array.isArray(result?.blocks) ? result.blocks : []).forEach((item) => {
    const taskId = String(item.taskId || "");
    const task = taskById[taskId];
    const start = String(item.start || "");
    const requestedEnd = String(item.end || "");
    if (!task || task.date !== selectedDate || task.status === "done" || task.fixedTime || task.kind === "fixed" || scheduledTaskIds.has(taskId)) return;
    if (isTicketPurchaseTask(task.title) && !parseTimeInSentence(task.title)) return;
    const meetingEnd = isPostMeetingTask(task.title) ? meetingEndForTask(task.title, manualBlocks) : null;
    if (isPostMeetingTask(task.title) && (!meetingEnd || toMinutes(start) < meetingEnd)) return;
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(requestedEnd) || toMinutes(requestedEnd) <= toMinutes(start)) return;
    const estimateMinutes = estimateMinutesForTitle(task.title, Number(task.estimateMinutes) || duration(start, requestedEnd));
    const end = toTime(toMinutes(start) + estimateMinutes);

    const block = {
      id: uid("block"),
      taskId,
      type: "task",
      date: selectedDate,
      title: String(item.title || ""),
      start,
      end,
      auto: true,
    };

    if (!isBlockInsideIntervals(block, intervals)) return;
    if (overlapsAny(block, manualBlocks.concat(pinned.blocks).concat(autoBlocks))) return;
    autoBlocks.push(block);
    scheduledTaskIds.add(taskId);
  });

  const scheduledTitles = manualBlocks
    .concat(autoBlocks)
    .map((block) => taskById[block.taskId]?.title || block.title)
    .filter(Boolean);
  questions = questions.filter((question) => {
    if (question.taskId && scheduledTaskIds.has(question.taskId)) return false;
    return !scheduledTitles.some((title) => titlesReferToSameTask(title, question.title));
  });

  const unscheduled = adjustedTasks.filter(
    (task) =>
      task.date === selectedDate &&
      task.status !== "done" &&
      !task.fixedTime &&
      task.kind !== "fixed" &&
      !scheduledTaskIds.has(task.id),
  );

  unscheduled.forEach((task) => {
    if (questions.some((question) => question.taskId === task.id || titlesReferToSameTask(question.title, task.title))) return;
    const ambiguousTicketPurchase = isTicketPurchaseTask(task.title) && !parseTimeInSentence(task.title);
    const missingMeeting = isPostMeetingTask(task.title) && !meetingEndForTask(task.title, manualBlocks);
    questions.push({
      id: uid("schedule-question"),
      taskId: task.id,
      title: task.title,
      estimateMinutes: Number(task.estimateMinutes) || 30,
      reason: ambiguousTicketPurchase
        ? "标题里的时间更像车次或出发时段，我还不知道你准备什么时候执行买票。"
        : missingMeeting
          ? "这是会后整理任务，但还没有找到对应会议的结束时间。"
          : "AI 没有为这个任务给出可靠时间块。",
      hint: ambiguousTicketPurchase
        ? "请先确认买票的执行时间或最晚完成时间，再放入手动表单。"
        : missingMeeting
          ? "请先补充会议时间，再安排到会后。"
          : "请补充时间约束，或手动指定它适合放在上午、下午、午休后还是某个固定事项前后。",
    });
  });

  pinned.conflicts.forEach((task) => {
    if (questions.some((question) => question.taskId === task.id)) return;
    questions.push({
      id: uid("schedule-question"),
      taskId: task.id,
      title: task.title,
      estimateMinutes: Number(task.estimateMinutes) || 30,
      reason: `固定时间 ${task.fixedStart} 与已有安排冲突，没能钉到该时间。`,
      hint: "请调整该任务时间，或先移开冲突的安排。",
    });
  });

  const reconciled = reconcileScheduleBlocks(
    existingBlocks
      .filter((block) => !(block.date === selectedDate && block.auto))
      .concat(autoBlocks),
    settings,
    selectedDate,
  );

  // 钉好的固定时间块不参与浮动 reconcile（避免被午休/工作时段裁掉），直接保留用户指定的时间。
  return {
    blocks: reconciled.blocks.concat(pinned.blocks),
    tasks: adjustedTasks,
    questions,
    message: result?.message || "",
  };
}

function preparePlannerForScheduling({ tasks, blocks, settings, selectedDate }) {
  const compacted = compactPlannerTasks(tasks, blocks);
  const reconciled = reconcileScheduleBlocks(compacted.blocks, settings, selectedDate);

  return {
    tasks: compacted.tasks,
    blocks: reconciled.blocks,
    removedTaskIds: reconciled.removedTaskIds,
  };
}

// 把「固定时间任务」（fixedTime + fixedStart）钉到其指定时间点，作为排期硬约束。
// 返回钉好的时间块、已钉任务 id 集合，以及因冲突无法钉入的任务（交给上层变成待决问题）。
function buildFixedTimeBlocks(tasks, settings, fixedBlocks, selectedDate) {
  const blocks = [];
  const pinnedTaskIds = new Set();
  const conflicts = [];
  tasks
    .filter(
      (task) =>
        task.date === selectedDate &&
        task.status !== "done" &&
        task.fixedTime &&
        /^\d{2}:\d{2}$/.test(task.fixedStart || ""),
    )
    .sort((a, b) => toMinutes(a.fixedStart) - toMinutes(b.fixedStart))
    .forEach((task) => {
      // 已被手动放置的固定时间任务不再重复钉块。
      if (fixedBlocks.some((block) => block.taskId === task.id)) {
        pinnedTaskIds.add(task.id);
        return;
      }
      const estimate = Math.max(10, estimateMinutesForTitle(task.title, Number(task.estimateMinutes) || 30));
      const start = task.fixedStart;
      const end = toTime(toMinutes(start) + estimate);
      const block = {
        id: uid("block"),
        taskId: task.id,
        type: "task",
        date: selectedDate,
        title: "",
        start,
        end,
        auto: true,
        fixedTime: true,
      };
      if (overlapsAny(block, fixedBlocks.concat(blocks))) {
        conflicts.push(task);
        return;
      }
      blocks.push(block);
      pinnedTaskIds.add(task.id);
    });
  return { blocks, pinnedTaskIds, conflicts };
}

// 为单个任务找一个合理的时间槽（用于「待决问题」里点击「今日」时的放置），
// 而不是粗暴塞进当天第一个空档：固定时间→其时间点；会后整理→不早于会议结束；其余→跳过午休的首个可用空档。
function findSlotForTask(task, settings, dayBlocks, selectedDate) {
  const estimate = Math.max(10, estimateMinutesForTitle(task.title, Number(task.estimateMinutes) || 30));
  const sameDay = dayBlocks.filter((block) => block.date === selectedDate);

  if (task.fixedTime && /^\d{2}:\d{2}$/.test(task.fixedStart || "")) {
    const start = task.fixedStart;
    const end = toTime(toMinutes(start) + estimate);
    if (!overlapsAny({ start, end }, sameDay)) return { start, end };
  }

  const earliest = isPostMeetingTask(task.title)
    ? meetingEndForTask(task.title, sameDay.filter((block) => block.type === "busy"))
    : null;
  const intervals = getFreeIntervals(settings, sameDay.concat(getProtectedBreaks(settings)));
  for (const interval of intervals) {
    const start = Math.max(interval.start, earliest || interval.start);
    if (start + estimate <= interval.end) {
      return { start: toTime(start), end: toTime(start + estimate) };
    }
  }
  return null;
}

function buildAutoBlocks({ tasks, existingBlocks, settings, selectedDate }) {
  const todayBlocks = existingBlocks.filter((block) => block.date === selectedDate);
  const manualBlocks = todayBlocks.filter((block) => !block.auto);
  const scheduledTaskIds = new Set(manualBlocks.map((block) => block.taskId).filter(Boolean));
  const busyTaskTitles = new Set(
    manualBlocks
      .filter((block) => block.type === "busy")
      .map((block) => normalizeTitle(block.title)),
  );

  // 先把固定时间任务钉到指定时间点，作为浮动任务排期的硬约束。
  const pinned = buildFixedTimeBlocks(tasks, settings, manualBlocks, selectedDate);
  const candidates = tasks
    .filter((task) =>
      task.date === selectedDate &&
      task.status !== "done" &&
      !task.fixedTime &&
      task.kind !== "fixed" &&
      !scheduledTaskIds.has(task.id) &&
      !busyTaskTitles.has(normalizeTitle(task.title))
    )
    .sort(compareTasksForScheduling)
    .map((task) => {
      const postMeeting = isPostMeetingTask(task.title);
      const meetingEnd = postMeeting ? meetingEndForTask(task.title, manualBlocks) : null;
      const ambiguousTicketPurchase = isTicketPurchaseTask(task.title) && !parseTimeInSentence(task.title);

      return {
        ...task,
        placementReason: ambiguousTicketPurchase
          ? "这像是买票任务，但标题里的时间更可能是车次/出发时间，不是你打算买票的执行时间。"
          : postMeeting ? "看起来是会后整理或后续行动，但我没找到对应会议时间。" : "",
        placementHint: ambiguousTicketPurchase
          ? "请告诉我你准备什么时候买票，或最晚几点前必须买好，再手动放入时间块。"
          : postMeeting ? "请先添加会议的不可用时间块，或手动指定这个任务的开始时间。" : "",
        needsPlacement: (postMeeting && !meetingEnd) || ambiguousTicketPurchase,
        earliestStart: postMeeting && meetingEnd ? meetingEnd : toMinutes((settings.workSegments || [{ start: "09:00" }])[0].start),
      };
    });

  const intervals = getFreeIntervals(settings, manualBlocks.concat(pinned.blocks));
  const autoBlocks = [];
  const questions = candidates
    .filter((task) => task.needsPlacement)
    .map((task) => ({
      id: uid("schedule-question"),
      taskId: task.id,
      title: task.title,
      estimateMinutes: Number(task.estimateMinutes) || 30,
      reason: task.placementReason,
      hint: task.placementHint,
    }));
  const unscheduled = candidates.filter((task) => !task.needsPlacement);

  intervals.forEach((interval) => {
    let cursor = interval.start;

    while (unscheduled.length > 0 && cursor < interval.end) {
      const taskIndex = unscheduled.findIndex((task) => {
        const estimate = Number(task.estimateMinutes) || 30;
        const start = Math.max(cursor, task.earliestStart || interval.start);
        return start + estimate <= interval.end;
      });

      if (taskIndex < 0) break;

      const task = unscheduled.splice(taskIndex, 1)[0];
      const estimate = Number(task.estimateMinutes) || 30;
      const start = Math.max(cursor, task.earliestStart || interval.start);
      const end = start + estimate;
      const tasksBefore = autoBlocks.filter((b) => b.type === "task").length;

      autoBlocks.push({
        id: uid("block"),
        taskId: task.id,
        type: "task",
        date: selectedDate,
        start: toTime(start),
        end: toTime(end),
        auto: true,
      });
      cursor = end + Number(tasksBefore % 2 === 0 ? (settings.shortBreak || 10) : (settings.longBreak || 30));
    }
  });

  unscheduled.forEach((task) => {
    questions.push({
      id: uid("schedule-question"),
      taskId: task.id,
      title: task.title,
      estimateMinutes: Number(task.estimateMinutes) || 30,
      reason: "当前固定安排和工作时间里没有足够连续空档。",
      hint: "可以拆小、延期，或在下方手动安排到你觉得合适的位置。",
    });
  });

  pinned.conflicts.forEach((task) => {
    questions.push({
      id: uid("schedule-question"),
      taskId: task.id,
      title: task.title,
      estimateMinutes: Number(task.estimateMinutes) || 30,
      reason: `固定时间 ${task.fixedStart} 与已有安排冲突，没能钉到该时间。`,
      hint: "请调整该任务时间，或先移开冲突的安排。",
    });
  });

  const reconciled = reconcileScheduleBlocks(
    existingBlocks
      .filter((block) => !(block.date === selectedDate && block.auto))
      .concat(autoBlocks),
    settings,
    selectedDate,
  );

  // 钉好的固定时间块不参与上面的浮动 reconcile（避免被午休/工作时段裁掉），直接保留用户指定的时间。
  return {
    blocks: reconciled.blocks.concat(pinned.blocks),
    questions,
  };
}

function App() {
  const [planner, setPlanner] = usePlannerStore();
  const autoSchedulingRef = useRef(false); // 防自动安排并发（每实例，替代模块全局）—— from PR #6 (hrjtju)
  const [localAiKey, setLocalAiKey] = useState(readLocalAiKey);
  const [serverAiKeyLoaded, setServerAiKeyLoaded] = useState(false);
  const [activeView, setActiveView] = useState("today");
  const [settingsOpen, setSettingsOpen] = useState(false); // 设置抽屉开合
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("plan-pilot-theme") || "warm"; } catch { return "warm"; }
  });
  const [selectedDate, setSelectedDate] = useState(getLocalDate());
  const [taskDraft, setTaskDraft] = useState({
    title: "",
    estimateMinutes: 60,
    priority: "medium",
    goalId: "",
  });
  const [goalDraft, setGoalDraft] = useState({
    title: "",
    type: "long",
    parentId: "",
    priority: "medium",
  });
  const [blockDraft, setBlockDraft] = useState({
    type: "task",
    taskId: "",
    title: "",
    start: "09:00",
    end: "10:00",
  });
  const [breakdownDraft, setBreakdownDraft] = useState({
    goalId: "",
    outcome: "",
    deadline: "",
    constraints: "",
  });
  const [breakdownSuggestions, setBreakdownSuggestions] = useState([]);
  const [aiStatus, setAiStatus] = useState({ loading: false, error: "", message: "" });
  const [aiTaskSuggestions, setAiTaskSuggestions] = useState([]);
  const [todayAiReply, setTodayAiReply] = useState("");
  const [todayGuideActive, setTodayGuideActive] = useState(false);
  const [schedulePreview, setSchedulePreview] = useState(null); // 自动安排的待确认方案（不落盘）
  const [scheduleUndo, setScheduleUndo] = useState(null); // 应用排期前的快照，供撤销
  const [scheduleNotice, setScheduleNotice] = useState({ text: "", tone: "" }); // 时间分配面板的就地反馈（成功/被规则拦截的原因）
  const [scheduleQuestions, setScheduleQuestions] = useState([]);
  const [planningCoach, setPlanningCoach] = useState({
    scope: "today",
    messages: [],
    input: "",
    suggestions: [],
    loading: false,
    error: "",
  });
  const [reviewDraft, setReviewDraft] = useState({
    completed: "",
    blockers: "",
    adjustments: "",
    tomorrowFocus: "",
  });
  const [recurringDraft, setRecurringDraft] = useState({
    title: "",
    start: "09:00",
    end: "10:00",
    dayOfWeek: 1,
    endDate: "",
  });
  const [quickRecurringTitle, setQuickRecurringTitle] = useState("");
  const [showRecurringModal, setShowRecurringModal] = useState(false);
  const [editingRecurringId, setEditingRecurringId] = useState(null);
  const [showSegmentModal, setShowSegmentModal] = useState(false);
  const [segmentDraft, setSegmentDraft] = useState({ start: "09:00", end: "12:00" });
  const dayNames = ["日", "一", "二", "三", "四", "五", "六"];

  useEffect(() => {
    setScheduleQuestions([]);
    setTodayGuideActive(false);
    setSchedulePreview(null);
    setScheduleUndo(null);
    setScheduleNotice({ text: "", tone: "" });
  }, [selectedDate]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("plan-pilot-theme", theme); } catch (e) { /* ignore */ }
  }, [theme]);

  // 跨天滚动 + 「现在」线随时间移动：每 30s 检查一次本地日期。
  // 跨过午夜时，若用户仍停留在「旧的今天」，自动把视图滚到新的一天（时间线回到顶部）；手动切到别的日期则不打扰。
  // setNowTick 仅用于触发重渲染，让 DayTimeline 里 new Date() 计算的「现在」线实时移动、并在午夜归零。
  const todayRef = useRef(getLocalDate());
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      const today = getLocalDate();
      const prevToday = todayRef.current;
      if (today !== prevToday) {
        setSelectedDate((cur) => (cur === prevToday ? today : cur));
        todayRef.current = today;
      }
      setNowTick((n) => (n + 1) % 100000);
    }, 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    fetch("/api/ai/status")
      .then((r) => r.json())
      .then((s) => setServerAiKeyLoaded(!!s.configured))
      .catch(() => setServerAiKeyLoaded(false));
  }, []);

  const dayPlan = planner.dayPlans[selectedDate] || {
    fixed: "",
    energy: "正常",
    topThree: "",
    changes: "",
    morningDone: false,
  };

  const todayTasks = useMemo(
    () => planner.tasks.filter((task) => task.date === selectedDate),
    [planner.tasks, selectedDate],
  );

  const todayBlocks = useMemo(
    () => assignTimelineColumns(planner.blocks.filter((block) => block.date === selectedDate)),
    [planner.blocks, selectedDate],
  );

  const taskById = useMemo(
    () => Object.fromEntries(planner.tasks.map((task) => [task.id, task])),
    [planner.tasks],
  );
  const goalById = useMemo(
    () => Object.fromEntries(planner.goals.map((goal) => [goal.id, goal])),
    [planner.goals],
  );

  const activeGoals = planner.goals.filter((goal) => goal.status !== "done");
  const plannedMinutes = sum(todayTasks.filter((task) => task.status !== "done").map((task) => Number(task.estimateMinutes) || 0));
  const scheduledMinutes = sum(todayBlocks.map((block) => duration(block.start, block.end)));
  const workMinutes = workloadMinutes(planner.settings);
  const busyMinutes = sum(
    todayBlocks
      .filter((block) => block.type === "busy" || (!block.taskId && !block.auto))
      .map((block) => duration(block.start, block.end)),
  );
  const availableMinutes = Math.max(0, workMinutes - busyMinutes);
  const completedCount = todayTasks.filter((task) => task.status === "done").length;
  const upcomingHighlights = useMemo(() => {
    const weekGoals = planner.goals
      .filter((g) => g.type === "week" && g.status === "active")
      .sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority]);
    const monthGoals = planner.goals
      .filter((g) => g.type === "month" && g.status === "active")
      .sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority]);
    const nextBusy = planner.blocks
      .filter((b) => (b.type === "busy" || b.id?.startsWith("rec-")) && b.date >= selectedDate)
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    const fixedTask = planner.tasks
      .filter((t) => t.kind === "fixed" && t.date >= selectedDate)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    const bestBusy = nextBusy[0];
    let busy = null;
    if (bestBusy && fixedTask) {
      busy = (bestBusy.date + bestBusy.start).localeCompare(fixedTask.date) <= 0 ? bestBusy : { title: fixedTask.title, date: fixedTask.date, start: "" };
    } else {
      busy = bestBusy || (fixedTask ? { title: fixedTask.title, date: fixedTask.date, start: "" } : null);
    }
    const weekGoal = weekGoals[0] || null;
    const monthGoal = monthGoals[0] || null;
    const goalById = Object.fromEntries(planner.goals.map((g) => [g.id, g]));
    return {
      week: weekGoal ? { ...weekGoal, parentTitle: weekGoal.parentId ? goalById[weekGoal.parentId]?.title : "" } : null,
      month: monthGoal ? { ...monthGoal, parentTitle: monthGoal.parentId ? goalById[monthGoal.parentId]?.title : "" } : null,
      busy,
    };
  }, [planner.goals, planner.blocks, planner.tasks, selectedDate]);

  // 今日建议对话进行中（已生成、且 AI 尚未判定 done）就一直显示回答框，支持「持续引导直到用户说没有更多」。
  const showAiFollowUp = todayGuideActive && !aiStatus.loading;

  const viewHeadline =
    activeView === "today"
      ? formatHumanDate(selectedDate)
      : activeView === "goals"
        ? "先选个目标，拆成更小的下一步。"
        : "今天做得如何？明天要做什么？";
  const currentAiPreset = getAiProviderPreset(planner.ai.provider);
  const aiKeyLoaded = Boolean(localAiKey.trim() || serverAiKeyLoaded);

  function patchPlanner(updater) {
    setPlanner((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      return { ...current, ...next };
    });
  }

  function syncExplicitBusyBlocks(contextText) {
    const recoveredBlocks = recoverBusyBlocksFromPlanningContext(contextText, selectedDate, planner.blocks);
    if (!recoveredBlocks.length) return planner.blocks;
    // 落盘与返回使用同一份合并结果，避免「updater 用 current、返回用闭包」两次独立计算导致 AI 拿到旧时间块。
    const merged = mergeUniqueBusyBlocks(planner.blocks, recoveredBlocks);
    patchPlanner({ blocks: merged });
    return merged;
  }

  function currentDayPlanText() {
    return [dayPlan.fixed, dayPlan.topThree, dayPlan.changes].filter(Boolean).join("\n");
  }

  function updateAiSettings(patch) {
    patchPlanner((current) => ({
      ai: { ...current.ai, ...patch },
    }));
  }

  function updateLocalAiKey(value) {
    setLocalAiKey(value);
    try {
      if (value) localStorage.setItem(AI_KEY_STORAGE_KEY, value);
      else localStorage.removeItem(AI_KEY_STORAGE_KEY);
    } catch (error) {
      console.error("AI key localStorage write failed:", error);
    }
  }

  function applyAiProviderPreset(provider) {
    const preset = getAiProviderPreset(provider);
    updateAiSettings({
      provider,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      model: preset.model,
    });
  }

  function updateDayPlan(patch) {
    patchPlanner((current) => ({
      dayPlans: {
        ...current.dayPlans,
        [selectedDate]: {
          ...(current.dayPlans[selectedDate] || dayPlan),
          ...patch,
        },
      },
    }));
  }

  function addRecurring(item) {
    patchPlanner((current) => {
      const recurring = (current.recurring || []).concat(item);
      return { recurring, blocks: replaceRecurringBlocks(recurring, current.blocks) };
    });
  }

  function deleteRecurring(recId) {
    patchPlanner((current) => {
      const recurring = (current.recurring || []).filter((item) => item.id !== recId);
      return { recurring, blocks: replaceRecurringBlocks(recurring, current.blocks) };
    });
  }

  // 共享的「先落地固定安排」步骤：把 dayPlan 里写明的固定安排逐条落成不可用时间块与任务。
  // 三个入口（保存 / 今日建议 / 自动安排）都先调用它，再各自继续，从而保证「固定安排一定先生成」。
  // 既写入状态（patchPlanner），又同步返回结果，供随后的 AI 调用使用最新的 tasks/blocks（绕开 setState 异步）。
  // 纯计算版：在给定 base 之上算出「落地固定安排后」的 tasks/blocks，不写状态——供自动安排预览复用。
  function computeFixedPlanCommit(baseTasks, baseBlocks) {
    // 只从「固定安排 + 今日最重要」抽取；「变化与风险」是风险描述，不落任务，仅随 dayPlan 作为 AI 上下文。
    const taskText = [dayPlan.fixed, dayPlan.topThree].filter(Boolean).join("\n");
    const recoveredBusy = recoverBusyBlocksFromPlanningContext(taskText, selectedDate, baseBlocks);
    const blocksAfter = mergeUniqueBusyBlocks(baseBlocks, recoveredBusy);
    const fixedTasks = extractFixedTasksFromText(dayPlan.fixed, selectedDate, baseTasks);
    const actionTasks = extractActionTasksFromText(taskText, selectedDate, baseTasks.concat(fixedTasks));
    const newTasks = fixedTasks.concat(actionTasks);
    const tasksAfter = mergeDuplicateTasks(baseTasks.concat(newTasks));
    return { tasks: tasksAfter, blocks: blocksAfter, addedTaskCount: newTasks.length, addedBlockCount: blocksAfter.length - baseBlocks.length };
  }

  function commitFixedPlanFromDayPlan() {
    const r = computeFixedPlanCommit(planner.tasks, planner.blocks);
    if (r.addedTaskCount || r.addedBlockCount) patchPlanner({ tasks: r.tasks, blocks: r.blocks });
    return r;
  }

  function saveMorningPlan() {
    const { addedTaskCount, addedBlockCount } = commitFixedPlanFromDayPlan();
    patchPlanner((current) => ({
      dayPlans: {
        ...current.dayPlans,
        [selectedDate]: {
          ...(current.dayPlans[selectedDate] || dayPlan),
          morningDone: true,
        },
      },
    }));

    setAiStatus({
      loading: false,
      error: "",
      message: `晨间规划已保存。${addedTaskCount ? `已自动加入 ${addedTaskCount} 个今日任务。` : "没有识别到新的具体任务。"}${
        addedBlockCount ? ` 已加入 ${addedBlockCount} 个不可用时间块。` : ""
      }`,
    });
  }

  function extractFixedTasksFromText(text, date, existing) {
    const existingKeys = new Set(existing.map(taskIdentity));
    return String(text || "")
      .split(/[\n。；;]/)
      .map(normalizeSentence)
      // 带时间的承诺由 busy 块表示（占用时间轴），不再重复生成一个 kind:fixed 任务；只有无时间的承诺才落任务。
      .filter((s) => s && isBusySentence(s) && !isMeetingSentence(s) && !parseTimeInSentence(s) && looksLikeSingleActionItem(s))
      .map((s) => {
        const start = parseTimeInSentence(s);
        return {
          id: uid("task"),
          title: s,
          estimateMinutes: start ? defaultBusyDuration(s) : 30,
          priority: "medium",
          goalId: "",
          date,
          status: "open",
          kind: "fixed",
          createdAt: new Date().toISOString(),
        };
      })
      .filter((t) => {
        const key = taskIdentity(t);
        if (existingKeys.has(key)) return false;
        existingKeys.add(key);
        return true;
      });
  }

  function addTask(event) {
    event.preventDefault();
    submitTaskForm(event.currentTarget);
  }

  function submitTaskForm(form) {
    const title = String(fieldValue(form, "title", taskDraft.title)).trim();
    if (!title) return;
    const nextTask = {
      id: uid("task"),
      title,
      estimateMinutes: estimateMinutesForTitle(title, Number(fieldValue(form, "estimateMinutes", taskDraft.estimateMinutes)) || 30),
      priority: String(fieldValue(form, "priority", taskDraft.priority)),
      goalId: String(fieldValue(form, "goalId", taskDraft.goalId || "")),
      date: selectedDate,
      status: "open",
      createdAt: new Date().toISOString(),
    };

    patchPlanner((current) => ({
      tasks: mergeDuplicateTasks(current.tasks.concat(nextTask)),
      blocks: current.blocks.concat(extractBusyBlocksFromText(title, selectedDate, current.blocks)),
    }));
    setTaskDraft((draft) => ({ ...draft, title: "" }));
  }

  function addGoal(event) {
    event.preventDefault();
    submitGoalForm(event.currentTarget);
  }

  function submitGoalForm(form) {
    const title = String(fieldValue(form, "title", goalDraft.title)).trim();
    if (!title) return;

    patchPlanner((current) => ({
      goals: current.goals.concat({
        id: uid("goal"),
        title,
        type: String(fieldValue(form, "type", goalDraft.type)),
        parentId: String(fieldValue(form, "parentId", goalDraft.parentId || "")),
        priority: String(fieldValue(form, "priority", goalDraft.priority)),
        startDate: "",
        endDate: "",
        status: "active",
        progress: 0,
        createdAt: new Date().toISOString(),
      }),
    }));
    setGoalDraft((draft) => ({ ...draft, title: "", parentId: "" }));
  }

  function updateTask(taskId, patch) {
    patchPlanner((current) => ({
      tasks: current.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task)),
    }));
  }

  function deferTask(taskId) {
    const tomorrow = addDays(selectedDate, 1);
    deferTaskTo(taskId, tomorrow);
  }

  function deferTaskTo(taskId, targetDate) {
    patchPlanner((current) => ({
      tasks: current.tasks.map((task) => (task.id === taskId ? { ...task, date: targetDate, status: "open" } : task)),
      blocks: current.blocks.filter((block) => !(block.taskId === taskId && block.date === selectedDate)),
    }));
  }

  function deleteTask(taskId) {
    patchPlanner((current) => ({
      tasks: current.tasks.filter((task) => task.id !== taskId),
      blocks: current.blocks.filter((block) => block.taskId !== taskId),
    }));
  }

  async function autoSchedule() {
    if (autoSchedulingRef.current) return;
    autoSchedulingRef.current = true;
    try {
      // 全程「先算后用、确认才落盘」：在当前状态副本上计算，不直接改时间轴；结果存入 schedulePreview，等用户确认。
      const snapshot = { tasks: planner.tasks, blocks: planner.blocks };
      const committed = computeFixedPlanCommit(planner.tasks, planner.blocks);
      const prepared = preparePlannerForScheduling({
      tasks: committed.tasks,
      blocks: committed.blocks,
      settings: planner.settings,
      selectedDate,
    });
    const removedConstraintConflictCount = prepared.removedTaskIds.length;
    setSchedulePreview(null);
    setScheduleNotice({ text: "", tone: "" });

    const buildRulePreview = (note) => {
      const result = buildAutoBlocks({
        tasks: prepared.tasks,
        existingBlocks: prepared.blocks,
        settings: planner.settings,
        selectedDate,
      });
      const polished = polishAiBlocks(result.blocks, planner.settings.workSegments).filter((b) => !b._drop);
      return {
        tasks: result.tasks || prepared.tasks,
        blocks: polished,
        questions: result.questions,
        message: note,
        snapshot,
        addedTaskCount: committed.addedTaskCount,
        removedConstraintConflictCount,
      };
    };

    if (!planner.ai.enabled) {
      setSchedulePreview(buildRulePreview("规则排期预览。"));
      setAiStatus({ loading: false, error: "", message: "已生成排期预览，确认后才会改动你的时间轴。" });
      return;
    }

    const workSegments = (planner.settings.workSegments || []).map((s) => ({ start: s.start, end: s.end }));
    const protectedBreaks = getProtectedBreaks(planner.settings);
    const segList = workSegments.map((s) => `${s.start}-${s.end}`).join("、");
    const breakDesc =
      protectedBreaks.length > 0
        ? protectedBreaks.map((b) => `${b.start}-${b.end}`).join("、")
        : "无";

    setAiStatus({ loading: true, error: "", message: "AI 正在为你安排今日时间..." });
    try {
      const result = await callPlanningAi({
        ai: planner.ai,
        serverKeyOk: serverAiKeyLoaded,
        maxTokens: 2000,
        messages: [
          {
            role: "system",
            content:
              `You are a proactive daily time-blocking planner. Return only JSON: {\"message\":\"short scheduling note\",\"taskAdjustments\":[{\"taskId\":\"existing task id\",\"estimateMinutes\":120,\"reason\":\"why the estimate changed\"}],\"blocks\":[{\"taskId\":\"existing task id\",\"start\":\"HH:MM\",\"end\":\"HH:MM\",\"title\":\"optional\"}],\"questions\":[{\"taskId\":\"optional\",\"title\":\"...\",\"reason\":\"why uncertain\",\"hint\":\"what user should decide\"}]}.\n\n<<< HARD BOUNDARY RULE — VIOLATION IS UNACCEPTABLE >>>\nWork segments = [${segList}]. You MUST schedule EVERY block strictly within these time windows. A block starting before the first segment, ending after the last segment, or crossing into a protected break is a FATAL ERROR. Protected breaks (MUST NOT overlap any block): ${breakDesc}. Before outputting JSON, scan every block and verify: (1) start >= the segment's start, (2) end <= the segment's end, (3) the block does not intersect any protected break. If a task cannot fit, ask a question instead of violating the boundary.\n<<< END HARD BOUNDARY RULE >>>\n\nUse only existing task ids and never invent tasks. Re-plan the day from scratch on every call while respecting manual/fixed blocks and the already-pinned fixedTimeTasks as hard constraints: never output blocks for fixedTimeTasks and never overlap their time ranges; schedule the remaining tasks around them. Do not merely place tasks in input order: reason about urgency, cognitive load, context switching, dependencies, deadlines, energy, and realistic duration. Put deep research/design/writing work into coherent focus blocks, light admin work into lower-energy windows, and preserve dependencies: print before scan/upload/submit, scan before upload, outline/framework/core points before drafting, meeting preparation before the meeting, and meeting follow-up after the meeting. If a ticket-buying task does not say when the purchase itself must happen, ask the user instead of confusing the departure time with purchase time. If duration or placement is genuinely uncertain, ask one concise question instead of forcing a block. Time-splitting guidance: when multiple tasks in the same priority tier compete for limited time in one segment, split the available contiguous time among them proportionally by estimateMinutes rather than stacking arbitrarily. If a large task (≥120 min) cannot fit in a single free interval, consider splitting it across two sessions (e.g. morning + afternoon). Prefer high-focus deep work in the longest uninterrupted slots; put light admin tasks into shorter gaps. The currentAutoBlocks in the payload show what was previously auto-scheduled — you may keep, adjust, or replace them, but always explain significant changes in the message.`,
          },
          {
            role: "user",
            content: JSON.stringify({
              date: selectedDate,
              startOfDay: (planner.settings.workSegments && planner.settings.workSegments[0] && planner.settings.workSegments[0].start) || "09:00",
              endOfDay: (planner.settings.workSegments && planner.settings.workSegments[planner.settings.workSegments.length - 1] && planner.settings.workSegments[planner.settings.workSegments.length - 1].end) || "18:00",
              workSegments,
              dayPlan,
              protectedBreaks,
              tasks: prepared.tasks
                .filter((task) => task.date === selectedDate && task.status !== "done" && !task.fixedTime && task.kind !== "fixed")
                .map(({ id, title, estimateMinutes, priority, goalId }) => ({
                  id,
                  title,
                  estimateMinutes,
                  priority,
                  goalId,
                })),
              manualBlocks: prepared.blocks
                .filter((block) => block.date === selectedDate && !block.auto)
                .map(({ title, taskId, type, start, end }) => ({ title, taskId, type, start, end })),
              currentAutoBlocks: prepared.blocks
                .filter((block) => block.date === selectedDate && block.auto)
                .map(({ title, taskId, start, end }) => ({ title, taskId, start, end })),
              fixedTimeTasks: prepared.tasks
                .filter((task) => task.date === selectedDate && task.status !== "done" && task.fixedTime && task.fixedStart)
                .map(({ title, fixedStart, estimateMinutes }) => ({ title, start: fixedStart, estimateMinutes })),
              activeGoals: activeGoals.map(({ id, title, type, priority, status }) => ({ id, title, type, priority, status })),
            }),
          },
        ],
      });

      const schedule = normalizeAiScheduleResult(result, {
        tasks: prepared.tasks,
        existingBlocks: prepared.blocks,
        settings: planner.settings,
        selectedDate,
      });
      const polished = polishAiBlocks(schedule.blocks, planner.settings.workSegments).filter((b) => !b._drop);
      setSchedulePreview({
        tasks: schedule.tasks,
        blocks: polished,
        questions: schedule.questions,
        message: schedule.message || "AI 已基于最新任务重新规划。",
        snapshot,
        addedTaskCount: committed.addedTaskCount,
        removedConstraintConflictCount,
      });
      setAiStatus({ loading: false, error: "", message: "已生成 AI 排期预览，确认后才会改动你的时间轴。" });
    } catch (error) {
      setSchedulePreview(buildRulePreview(`AI 排期失败（${error.message}），已改用规则排期。`));
      setAiStatus({ loading: false, error: "", message: "已生成规则排期预览（AI 调用失败），确认后应用。" });
    }
    } finally {
      autoSchedulingRef.current = false;
    }
  }

  function confirmSchedulePreview() {
    if (!schedulePreview) return;
    const preview = schedulePreview;
    patchPlanner({ tasks: preview.tasks, blocks: preview.blocks });
    setScheduleQuestions(preview.questions || []);
    setScheduleUndo(preview.snapshot);
    setSchedulePreview(null);
    setAiStatus({
      loading: false,
      error: "",
      message: `${preview.message || "已应用排期。"}${
        preview.removedConstraintConflictCount ? ` 已移除 ${preview.removedConstraintConflictCount} 个与固定安排、休息或工作时段冲突的旧任务块。` : ""
      } 不满意可点「撤销」。`,
    });
  }

  function cancelSchedulePreview() {
    setSchedulePreview(null);
    setAiStatus({ loading: false, error: "", message: "已取消，未改动你的时间轴。" });
  }

  function undoSchedule() {
    if (!scheduleUndo) return;
    patchPlanner({ tasks: scheduleUndo.tasks, blocks: scheduleUndo.blocks });
    setScheduleQuestions([]);
    setScheduleUndo(null);
    setAiStatus({ loading: false, error: "", message: "已撤销，恢复到自动安排前的状态。" });
  }

  function addManualBlock(event) {
    event.preventDefault();
    submitBlockForm(event.currentTarget);
  }

  function addBlockDirectly(data) {
    const nextBlock = {
      id: uid("block"),
      taskId: data.type === "busy" ? "" : data.taskId,
      title: data.title || (data.type === "busy" ? "固定占用" : ""),
      type: data.type,
      date: selectedDate,
      start: data.start,
      end: data.end,
      auto: false,
    };
    if (toMinutes(nextBlock.end) <= toMinutes(nextBlock.start)) return false;
    if (nextBlock.type !== "busy" && !isInsideWorkWindow(nextBlock, planner.settings)) return false;
    if (nextBlock.type !== "busy" && overlapsAny(nextBlock, getProtectedBreaks(planner.settings))) return false;
    if (planner.blocks.some((block) => block.date === selectedDate && overlapsAny(nextBlock, [block]))) return false;

    patchPlanner((current) => ({
      blocks: current.blocks.concat(nextBlock),
    }));
    if (nextBlock.taskId) {
      setScheduleQuestions((questions) => questions.filter((question) => question.taskId !== nextBlock.taskId));
    }
    return true;
  }

  function submitBlockForm(form) {
    const start = String(fieldValue(form, "start", blockDraft.start));
    const end = String(fieldValue(form, "end", blockDraft.end));
    const type = String(fieldValue(form, "type", blockDraft.type));
    const taskId = String(fieldValue(form, "taskId", blockDraft.taskId || ""));
    const title = String(fieldValue(form, "title", blockDraft.title || "")).trim();
    if (toMinutes(end) <= toMinutes(start)) {
      setScheduleNotice({ text: "结束时间需要晚于开始时间。", tone: "error" });
      return;
    }

    const compacted = compactPlannerTasks(planner.tasks, planner.blocks);
    const selectedTask = planner.tasks.find((task) => task.id === taskId);
    const canonicalTask = taskId
      ? compacted.tasks.find(
          (task) => task.id === taskId || (task.date === selectedTask?.date && titlesReferToSameTask(task.title, selectedTask?.title)),
        )
      : null;
    const canonicalTaskId = canonicalTask?.id || taskId;
    const nextBlock = {
      id: uid("block"),
      taskId: type === "busy" ? "" : canonicalTaskId,
      title: title || (type === "busy" ? "固定占用" : ""),
      type,
      date: selectedDate,
      start,
      end,
      auto: false,
    };

    if (type !== "busy" && !isInsideWorkWindow(nextBlock, planner.settings)) {
      setScheduleNotice({ text: "任务时间块超出了当前工作时段，请调整时间，或先在左侧把工作时段改宽。", tone: "error" });
      return;
    }
    if (type !== "busy" && overlapsAny(nextBlock, getProtectedBreaks(planner.settings))) {
      setScheduleNotice({ text: "和默认午休 12:00-13:00 冲突，请换一个时间。", tone: "error" });
      return;
    }

    const blocksWithoutOverriddenAuto = compacted.blocks.filter(
      (block) =>
        !(
          block.date === selectedDate &&
          block.auto &&
          ((canonicalTaskId && block.taskId === canonicalTaskId) || overlapsAny(nextBlock, [block]))
        ),
    );
    const conflict = blocksWithoutOverriddenAuto.find(
      (block) => block.date === selectedDate && overlapsAny(nextBlock, [block]),
    );
    if (conflict) {
      const conflictTask = compacted.tasks.find((task) => task.id === conflict.taskId);
      setScheduleNotice({
        text: `这个时间与"${conflictTask?.title || conflict.title || "已有时间块"}"重叠，请把它放到空的时间段。`,
        tone: "error",
      });
      return;
    }

    patchPlanner({
      tasks: compacted.tasks,
      blocks: blocksWithoutOverriddenAuto.concat(nextBlock),
    });
    setBlockDraft({
      type: "task",
      taskId: "",
      title: "",
      start: planner.settings.workSegments?.[0]?.start || "09:00",
      end: toTime(toMinutes(planner.settings.workSegments?.[0]?.start || "09:00") + 60),
    });
    if (canonicalTaskId) {
      const scheduledTask = compacted.tasks.find((task) => task.id === canonicalTaskId);
      setScheduleQuestions((questions) =>
        questions.filter(
          (question) =>
            question.taskId !== canonicalTaskId &&
            !titlesReferToSameTask(question.title, scheduledTask?.title),
        ),
      );
    }
    setScheduleNotice({ text: "已加入手动时间块。再次点「自动安排」时会保留它并重排其余任务。", tone: "info" });
  }

  function deleteBlock(blockId) {
    patchPlanner((current) => ({
      blocks: current.blocks.filter((block) => block.id !== blockId),
    }));
  }

  function updateBlock(blockId, patch) {
    const existing = planner.blocks.find((block) => block.id === blockId);
    if (!existing) return false;
    const nextBlock = { ...existing, ...patch };
    if (nextBlock.type !== "busy" && !isInsideWorkWindow(nextBlock, planner.settings)) {
      setScheduleNotice({ text: "任务时间块超出了当前工作时段，请调整时间，或先在左侧把工作时段改宽。", tone: "error" });
      return false;
    }
    if (nextBlock.type !== "busy" && overlapsAny(nextBlock, getProtectedBreaks(planner.settings))) {
      setScheduleNotice({ text: "和默认午休 12:00-13:00 冲突，请换一个时间。", tone: "error" });
      return false;
    }
    const remainingBlocks = planner.blocks.filter(
      (block) => block.id === blockId || !(block.auto && block.date === nextBlock.date && overlapsAny(nextBlock, [block])),
    );
    const conflict = remainingBlocks.find(
      (block) => block.id !== blockId && block.date === nextBlock.date && overlapsAny(nextBlock, [block]),
    );
    if (conflict) {
      const conflictTask = planner.tasks.find((task) => task.id === conflict.taskId);
      setScheduleNotice({
        text: `这个时间与"${conflictTask?.title || conflict.title || "已有时间块"}"重叠，请把它放到空的时间段。`,
        tone: "error",
      });
      return false;
    }
    patchPlanner((current) => ({
      blocks: current.blocks
        .filter((block) => block.id === blockId || !(block.auto && block.date === nextBlock.date && overlapsAny(nextBlock, [block])))
        .map((block) => (block.id === blockId ? { ...block, ...patch } : block)),
    }));
    setScheduleNotice({ text: "时间块已更新。再次点「自动安排」时会据此重排其余任务。", tone: "info" });
    return true;
  }

  // 拖拽重排：被拖块放到落点（几乎可放任意时间，含非工作时段/午休——这是用户手动决定）；
  // 只有撞到「不可用 / 固定时间」块才弹回。原本在它下方、且现在会冲突的任务块温和顺延（跳过硬锚点）。永不删块。
  function applyDragReschedule(blockId, newStartMin, newEndMin) {
    const date = selectedDate;
    const moved = planner.blocks.find((b) => b.id === blockId);
    if (!moved) return false;
    const origStart = toMinutes(moved.start);
    let startMin;
    let endMin;
    if (newStartMin !== origStart) {
      // 移动：保持时长，整体限制在 00:00–24:00
      const dur = Math.max(10, newEndMin - newStartMin);
      startMin = Math.max(0, Math.min(newStartMin, 1440 - dur));
      endMin = startMin + dur;
    } else {
      // 拉伸：固定开始，结束封顶 24:00
      startMin = origStart;
      endMin = Math.max(startMin + 10, Math.min(newEndMin, 1440));
    }
    const ns = startMin;
    const dur0 = endMin - startMin;
    const movedNew = { ...moved, start: toTime(startMin), end: toTime(endMin), auto: false }; // 手动拖动后视为手动放置
    const today = planner.blocks.filter((b) => b.date === date);
    const others = planner.blocks.filter((b) => b.date !== date);
    // 硬锚点：不可用块 + 固定时间任务块（不能重叠）
    const hard = today.filter((b) => b.id !== blockId && (b.type === "busy" || b.fixedTime));
    if (hard.some((a) => overlapsAny(movedNew, [a]))) {
      setScheduleNotice({ text: "这里是不可用 / 固定时间安排，不能放在它上面，已弹回。", tone: "error" });
      return false;
    }
    const hardIv = hard.map((a) => [toMinutes(a.start), toMinutes(a.end)]);
    const pushPastHard = (start, dur) => {
      let s = start;
      let again = true;
      while (again) {
        again = false;
        for (const [hs, he] of hardIv) {
          if (s < he && s + dur > hs) {
            s = he;
            again = true;
          }
        }
      }
      return s;
    };
    // 可顺延：当天其它任务块（非不可用、非固定时间），按开始排序
    const movable = today
      .filter((b) => b.id !== blockId && b.type !== "busy" && !b.fixedTime)
      .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    const movedOrigStart = toMinutes(moved.start);
    let cursor = ns + dur0;
    const newMovable = movable.map((b) => {
      const bs = toMinutes(b.start);
      const bdur = duration(b.start, b.end);
      if (bs >= movedOrigStart && bs < cursor) {
        const s = pushPastHard(cursor, bdur);
        if (s + bdur <= 1440) {
          cursor = s + bdur;
          return { ...b, start: toTime(s), end: toTime(s + bdur) };
        }
        return b; // 顺延会超过 24:00 → 保持原位，不推到 25 点
      }
      if (bs >= movedOrigStart) cursor = Math.max(cursor, bs + bdur);
      return b;
    });
    patchPlanner({ blocks: others.concat(hard, [movedNew], newMovable) });
    setScheduleNotice({ text: "已移动；下方冲突的任务已联动顺延。", tone: "info" });
    return true;
  }

  // 把右侧待办任务拖到时间轴落点：已在轴上则按拖拽重排移动（含联动顺延）；否则在落点新建手动块（auto:false）。
  // 与拖拽一致：几乎可放任意时间，只有撞「不可用 / 固定时间」才拒绝；落点夹在 00:00–24:00 内。
  function scheduleTaskAtMinute(taskId, startMin) {
    const task = planner.tasks.find((t) => t.id === taskId);
    if (!task) return false;
    const today = planner.blocks.filter((b) => b.date === selectedDate);
    const existing = today.find((b) => b.taskId === taskId && b.type !== "busy");
    if (existing) {
      return applyDragReschedule(existing.id, startMin, startMin + duration(existing.start, existing.end));
    }
    const estimate = Math.max(10, estimateMinutesForTitle(task.title, Number(task.estimateMinutes) || 30));
    const start = Math.max(0, Math.min(startMin, 1440 - estimate));
    const end = start + estimate;
    const candidate = { start: toTime(start), end: toTime(end) };
    // 硬锚点：不可用块 + 固定时间块，不能压上去
    const hard = today.filter((b) => b.type === "busy" || b.fixedTime);
    if (hard.some((a) => overlapsAny(candidate, [a]))) {
      setScheduleNotice({ text: `「${task.title}」放到 ${toTime(start)} 会和不可用 / 固定时间冲突，换个空档再放。`, tone: "error" });
      return false;
    }
    // 温和顺延：落点处及其下方、与新块冲突的可动块依次下移（跳过硬锚点、封顶 24:00），不删块、不视觉重叠。
    const hardIv = hard.map((a) => [toMinutes(a.start), toMinutes(a.end)]);
    const pushPastHard = (s, dur) => {
      let cur = s;
      let again = true;
      while (again) {
        again = false;
        for (const [hs, he] of hardIv) {
          if (cur < he && cur + dur > hs) { cur = he; again = true; }
        }
      }
      return cur;
    };
    const movable = today
      .filter((b) => b.type !== "busy" && !b.fixedTime)
      .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    let cursor = end;
    const newMovable = movable.map((b) => {
      const bs = toMinutes(b.start);
      const bdur = duration(b.start, b.end);
      if (bs >= start && bs < cursor) {
        const s = pushPastHard(cursor, bdur);
        if (s + bdur <= 1440) { cursor = s + bdur; return { ...b, start: toTime(s), end: toTime(s + bdur) }; }
        return b; // 顺延会超过 24:00 → 保持原位
      }
      if (bs >= start) cursor = Math.max(cursor, bs + bdur);
      return b;
    });
    const block = { id: uid("block"), taskId, title: "", type: "task", date: selectedDate, start: toTime(start), end: toTime(end), auto: false };
    const others = planner.blocks.filter((b) => b.date !== selectedDate);
    patchPlanner({ blocks: others.concat(hard, newMovable, [block]) });
    setScheduleQuestions((qs) => qs.filter((q) => q.taskId !== taskId));
    setScheduleNotice({ text: `已把「${task.title}」安排到 ${toTime(start)}–${toTime(end)}（拖动可微调，下方冲突已顺延）。`, tone: "info" });
    return true;
  }

  function updateGoal(goalId, patch) {
    patchPlanner((current) => ({
      goals: current.goals.map((goal) => (goal.id === goalId ? { ...goal, ...patch } : goal)),
    }));
  }

  function deleteGoal(goalId) {
    patchPlanner((current) => ({
      goals: current.goals
        .filter((goal) => goal.id !== goalId)
        .map((goal) => (goal.parentId === goalId ? { ...goal, parentId: "" } : goal)),
    }));
  }

  async function generateBreakdown(event) {
    event.preventDefault();
    const goal = planner.goals.find((item) => item.id === breakdownDraft.goalId) || planner.goals[0];
    if (!goal) return;
    setBreakdownDraft((draft) => ({ ...draft, goalId: goal.id }));

    if (!planner.ai.enabled) {
      setBreakdownSuggestions(filterBreakdownItems(makeBreakdown(goal, breakdownDraft, selectedDate), planner, goal));
      setAiStatus({ loading: false, error: "", message: "已使用规则拆解。启用 AI 并填写 Key 后，可改用大模型拆解。" });
      return;
    }

    setAiStatus({ loading: true, error: "", message: "AI 正在拆解目标..." });
    try {
      const result = await callPlanningAi({
        ai: planner.ai,
        serverKeyOk: serverAiKeyLoaded,
        maxTokens: 1800,
        messages: [
          {
            role: "system",
            content:
              "你是 Plan Pilot 的规划助手。把用户目标拆为下一层计划，仅返回 JSON：{\"summary\":\"一句话\",\"items\":[{\"kind\":\"goal\",\"type\":\"month|week\",\"title\":\"...\",\"priority\":\"high|medium|low\"},{\"kind\":\"task\",\"date\":\"YYYY-MM-DD\",\"title\":\"...\",\"estimateMinutes\":60,\"priority\":\"high|medium|low\"}]}。约束：现有任务是上下文不要复制；目标不清时返回 items:[] 并用 summary 提 1-3 个追问；复杂设计任务(方案/框架/技术路线)估时≥180分钟。",
          },
          {
            role: "user",
            content: JSON.stringify({
              today: selectedDate,
              goal,
              desiredOutcome: breakdownDraft.outcome,
              deadline: breakdownDraft.deadline,
              constraints: breakdownDraft.constraints,
              existingGoals: planner.goals.map(({ id, title, type, parentId, status }) => ({ id, title, type, parentId, status })),
            }),
          },
        ],
      });
      const items = filterBreakdownItems(normalizeBreakdownItems(result.items, goal, selectedDate), planner, goal);
      if (!items.length) {
        setBreakdownSuggestions([]);
        setAiStatus({
          loading: false,
          error: "",
          message: result.summary || result.message || "AI 需要你先补充目标、交付物、截止时间或限制条件。",
        });
        return;
      }
      setBreakdownSuggestions(items);
      setAiStatus({ loading: false, error: "", message: result.summary || "AI 已生成拆解建议。" });
    } catch (error) {
      setBreakdownSuggestions(filterBreakdownItems(makeBreakdown(goal, breakdownDraft, selectedDate), planner, goal));
      setAiStatus({
        loading: false,
        error: `${error.message || "AI 调用失败"} 已切换为规则拆解。`,
        message: "",
      });
    }
  }

  function acceptBreakdown() {
    const goal = planner.goals.find((item) => item.id === breakdownDraft.goalId) || planner.goals[0];
    if (!goal || breakdownSuggestions.length === 0) return;

    patchPlanner((current) => ({
      goals: current.goals.concat(
        filterBreakdownItems(breakdownSuggestions, current, goal)
          .filter((item) => item.kind === "goal")
          .map((item) => ({
            id: uid("goal"),
            title: item.title,
            type: item.type,
            parentId: goal.id,
            priority: item.priority,
            status: "active",
            progress: 0,
            deadline: breakdownDraft.deadline,
            createdAt: new Date().toISOString(),
          })),
      ),
      tasks: mergeDuplicateTasks(
        current.tasks.concat(
          filterBreakdownItems(breakdownSuggestions, current, goal)
          .filter((item) => item.kind === "task")
          .map((item) => ({
            id: uid("task"),
            title: item.title,
            estimateMinutes: item.estimateMinutes,
            priority: item.priority,
            goalId: goal.id,
            date: item.date,
            status: "open",
            createdAt: new Date().toISOString(),
          })),
        ),
      ),
    }));
    setBreakdownSuggestions([]);
  }

  async function generateTodayAiGuide(extraAnswer = "") {
    const followUpAnswer = typeof extraAnswer === "string" ? extraAnswer.trim() : "";

    if (!planner.ai.enabled) {
      setAiStatus({ loading: false, error: "请先在设置里启用 AI（点左侧齿轮）。", message: "" });
      return;
    }

    // 先把固定安排逐条落地（规则兜底），再让模型补充——保证「固定安排一定先生成」，绕开 setState 异步用返回值喂模型。
    const committed = followUpAnswer ? { tasks: planner.tasks, blocks: planner.blocks, addedTaskCount: 0 } : commitFixedPlanFromDayPlan();
    const committedTodayTasks = committed.tasks.filter((task) => task.date === selectedDate);
    const guideBlocks = sortBlocks(committed.blocks.filter((block) => block.date === selectedDate));
    if (!followUpAnswer) setAiTaskSuggestions([]); // 仅新一轮清空；追问轮累积保留未「加入」的建议
    setAiStatus({ loading: true, error: "", message: "AI 正在根据目标、任务和不可用时间生成建议..." });
    try {
      const result = await callPlanningAi({
        ai: planner.ai,
        serverKeyOk: serverAiKeyLoaded,
        maxTokens: 1600,
        messages: [
          {
            role: "system",
            content: TODAY_GUIDE_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: JSON.stringify({
              date: selectedDate,
              dayPlan,
              settings: planner.settings,
              activeGoals: activeGoals.map(({ id, title, type, priority, status }) => ({ id, title, type, priority, status })),
              todayTasks: committedTodayTasks.map(({ title, estimateMinutes, priority, status, goalId, fixedTime, fixedStart }) => ({ title, estimateMinutes, priority, status, goalId, fixedTime, fixedStart })),
              timeBlocks: guideBlocks.map(({ title, taskId, type, start, end, auto }) => ({ title, taskId, type, start, end, auto })),
              previousAiQuestion: followUpAnswer ? aiStatus.message : "",
              followUpAnswer,
            }),
          },
        ],
      });
      const fixedNote = committed.addedTaskCount ? `已根据固定安排自动生成 ${committed.addedTaskCount} 个任务。` : "";
      // 持续引导：只要模型没判定 done，就保持对话框开启，让用户继续补充或回答引导问题。
      setTodayGuideActive(result.done !== true);
      const validGoalIds = new Set(activeGoals.map((goal) => goal.id));
      const rawSuggestions = normalizeTaskSuggestions(result.tasks, selectedDate).map((task) => ({
        ...task,
        goalId: validGoalIds.has(task.goalId) ? task.goalId : "",
      }));
      const suggestions = filterTaskSuggestions(rawSuggestions, committed.tasks);
      // 跨轮累积、绝不在 done/空轮清空——否则会把用户还没点「加入今日任务」的建议清掉。
      const pendingReminder = aiTaskSuggestions.length ? "下方还有未加入的建议，记得点“加入今日任务”。" : "";
      if (!suggestions.length) {
        const noNewTaskNote = rawSuggestions.length
          ? "模型补充的任务均已存在，未重复新增。"
          : committedTodayTasks.length
            ? "已有任务足够，无需补充。可点击“自动安排”分配现有任务。"
            : "当前没有可加入的具体任务。请在固定安排或今日重点里补充今天要做的事。";
        setAiStatus({
          loading: false,
          error: "",
          message: [fixedNote, result.message, noNewTaskNote, pendingReminder].filter(Boolean).join(" "),
        });
        return;
      }
      setAiTaskSuggestions((prev) => {
        const seen = new Set(prev.map((item) => normalizeTitle(item.title)));
        return prev.concat(suggestions.filter((item) => !seen.has(normalizeTitle(item.title))));
      });
      setAiStatus({ loading: false, error: "", message: [fixedNote, result.message || "AI 已生成今日建议。"].filter(Boolean).join(" ") });
    } catch (error) {
      setAiStatus({ loading: false, error: error.message || "AI 调用失败。", message: "" });
    }
  }

  function sendTodayAiReply(event) {
    event.preventDefault();
    const reply = todayAiReply.trim();
    if (!reply || aiStatus.loading) return;
    setTodayAiReply("");
    generateTodayAiGuide(reply);
  }

  function acceptAiTaskSuggestions() {
    if (!aiTaskSuggestions.length) return;
    patchPlanner((current) => ({
      tasks: mergeDuplicateTasks(
        current.tasks.concat(
          filterTaskSuggestions(aiTaskSuggestions, current.tasks).map((task) => ({
            id: uid("task"),
            title: task.title,
            estimateMinutes: task.estimateMinutes,
            priority: task.priority,
            goalId: task.goalId,
            date: task.date,
            status: "open",
            ...(task.fixedTime && task.fixedStart ? { fixedTime: true, fixedStart: task.fixedStart } : {}),
            createdAt: new Date().toISOString(),
          })),
        ),
      ),
    }));
    setAiTaskSuggestions([]);
  }

  async function runPlanningCoach(nextMessages) {
    if (!planner.ai.enabled) {
      setPlanningCoach((coach) => ({
        ...coach,
        loading: false,
        error: "请先在设置里启用 AI（点左侧齿轮）。",
      }));
      return;
    }

    const userPlanningContext = [
      currentDayPlanText(),
      ...nextMessages.filter((message) => message.role === "user").map((message) => message.content),
    ]
      .filter(Boolean)
      .join("\n");
    const blocksWithExplicitCommitments = syncExplicitBusyBlocks(userPlanningContext);
    const coachPlanner = { ...planner, blocks: blocksWithExplicitCommitments };
    setPlanningCoach((coach) => ({ ...coach, loading: true, error: "", messages: nextMessages }));

    try {
      const result = await callPlanningAi({
        ai: planner.ai,
        serverKeyOk: serverAiKeyLoaded,
        maxTokens: 1800,
        messages: [
          ...planningCoachSystemMessages(),
          {
            role: "user",
            content: JSON.stringify({
              today: selectedDate,
              interviewScope: planningCoach.scope,
              dayPlan,
              existingGoals: planner.goals.map(({ id, title, type, parentId, status }) => ({ id, title, type, parentId, status })),
              existingTasks: planner.tasks.map(({ title, date, estimateMinutes, priority, status, goalId }) => ({
                title,
                date,
                estimateMinutes,
                priority,
                status,
                goalId,
              })),
              timeBlocks: blocksWithExplicitCommitments
                .filter((block) => block.date === selectedDate)
                .map(({ title, type, start, end, taskId }) => ({ title, type, start, end, taskId })),
              doNotRepeatTaskTitles: planner.tasks.map((task) => task.title),
              doNotRepeatGoalTitles: planner.goals.map((goal) => goal.title),
            }),
          },
          ...nextMessages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        ],
      });

      const normalizedItems = attachKnownGoalReferences(
        normalizeCoachItems(collectCoachItems(result), selectedDate),
        coachPlanner,
      );
      const items = filterCoachItems(normalizedItems, coachPlanner);
      setPlanningCoach((coach) => ({
        ...coach,
        loading: false,
        error: "",
        messages: nextMessages.concat({ role: "assistant", content: result.message || "我已经整理出一组建议。" }),
        suggestions: items,
      }));
    } catch (error) {
      setPlanningCoach((coach) => ({
        ...coach,
        loading: false,
        error: error.message || "AI 规划访谈失败。",
      }));
    }
  }

  function startPlanningCoach() {
    const message = {
      role: "user",
      content: planningCoachStartMessage(planningCoach.scope),
    };
    runPlanningCoach([message]);
  }

  function sendPlanningCoachMessage(event) {
    event.preventDefault();
    const content = planningCoach.input.trim();
    if (!content || planningCoach.loading) return;
    const nextMessages = planningCoach.messages.concat({ role: "user", content });
    setPlanningCoach((coach) => ({ ...coach, input: "" }));
    runPlanningCoach(nextMessages);
  }

  function acceptPlanningCoachSuggestions() {
    if (!planningCoach.suggestions.length) return;

    function prepareAcceptance(current) {
      const validGoalIds = new Set(current.goals.map((goal) => goal.id));
      const filteredSuggestions = filterCoachItems(planningCoach.suggestions, current);
      const goalItems = filteredSuggestions.filter((item) => item.kind === "goal");
      const taskItems = filteredSuggestions.filter((item) => item.kind === "task");
      const busyItems = filteredSuggestions.filter((item) => item.kind === "busy");
      const existingGoalKeys = new Set(current.goals.map(goalIdentity));
      const existingGoalByTitle = new Map(current.goals.map((goal) => [normalizeTitle(goal.title), goal.id]));
      const preparedGoals = goalItems.map((item) => ({ ...item, newId: uid("goal") }));
      const suggestedGoalIdMap = new Map();

      preparedGoals.forEach((item) => {
        if (item.tempId) suggestedGoalIdMap.set(item.tempId, item.newId);
        suggestedGoalIdMap.set(item.title, item.newId);
        suggestedGoalIdMap.set(normalizeTitle(item.title), item.newId);
      });

      function resolveGoalReference(reference, title) {
        const value = String(reference || "").trim();
        const normalized = normalizeTitle(title || value);
        if (validGoalIds.has(value)) return value;
        if (suggestedGoalIdMap.has(value)) return suggestedGoalIdMap.get(value);
        if (suggestedGoalIdMap.has(normalized)) return suggestedGoalIdMap.get(normalized);
        if (existingGoalByTitle.has(normalized)) return existingGoalByTitle.get(normalized);
        const similarExisting = current.goals.find((goal) => titleLooksDuplicate(goal.title, title || value));
        return similarExisting?.id || "";
      }

      const goals = preparedGoals
        .map((item) => ({
          id: item.newId,
          title: item.title,
          type: item.type,
          parentId: resolveGoalReference(item.parentId, item.parentTitle),
          priority: item.priority,
          status: "active",
          progress: 0,
          createdAt: new Date().toISOString(),
        }))
        .filter((goal) => {
          const key = goalIdentity(goal);
          if (existingGoalKeys.has(key)) return false;
          existingGoalKeys.add(key);
          return true;
        });

      const tasks = filterTaskSuggestions(
        taskItems.map((item) => ({
          title: item.title,
          estimateMinutes: item.estimateMinutes,
          priority: item.priority,
          date: item.date,
          goalId: resolveGoalReference(item.goalId, item.goalTitle),
        })),
        current.tasks,
      ).map((item) => ({
        id: uid("task"),
        title: item.title,
        estimateMinutes: item.estimateMinutes,
        priority: item.priority,
        goalId: item.goalId,
        date: item.date,
        status: "open",
        createdAt: new Date().toISOString(),
      }));

      const blocks = busyItems.map((item) => ({
        id: uid("block"),
        date: item.date,
        type: "busy",
        taskId: "",
        title: item.title,
        start: item.start,
        end: item.end,
        auto: false,
      }));

      return {
        goals,
        tasks,
        blocks,
        summary: {
          goals: goals.length,
          tasks: tasks.length,
          todayTasks: tasks.filter((task) => task.date === selectedDate).length,
          futureTasks: tasks.filter((task) => task.date !== selectedDate).length,
          busy: blocks.length,
        },
      };
    }

    let summary;

    patchPlanner((current) => {
      const prepared = prepareAcceptance(current);
      summary = prepared.summary;
      return {
        goals: current.goals.concat(prepared.goals),
        tasks: mergeDuplicateTasks(current.tasks.concat(prepared.tasks)),
        blocks: current.blocks.concat(prepared.blocks),
      };
    });

    setPlanningCoach((coach) => ({
      ...coach,
      suggestions: [],
      messages: coach.messages.concat({
        role: "assistant",
        content: `已加入计划：${summary.goals} 个目标、${summary.tasks} 个任务（今日 ${summary.todayTasks} 个，后续 ${summary.futureTasks} 个）、${summary.busy} 个固定安排。后续任务可在"目标"页的后续任务区查看。`,
      }),
    }));
  }

  function exportData() {
    const exportPlanner = JSON.parse(JSON.stringify(planner));
    if (exportPlanner.ai) delete exportPlanner.ai.apiKey;
    const blob = new Blob([JSON.stringify(exportPlanner, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `plan-pilot-${getLocalDate()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function resetLocalData() {
    const CONFIRM_TEXT = "我确认清空本地数据";
    const input = window.prompt(`此操作将清空所有目标、任务、时间块和复盘记录，且无法撤销。\n\n请输入"${CONFIRM_TEXT}"以继续：`);
    if (input !== CONFIRM_TEXT) {
      if (input !== null) window.alert("输入不匹配，操作已取消。");
      return;
    }
    setPlanner(hydrateState(defaultState));
    updateLocalAiKey("");
    // Immediately persist empty state to server to clear disk files
    fetch("/api/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(defaultState),
    }).catch(() => {});
    fetch("/api/profile", { method: "DELETE" }).catch(() => {});
    setSelectedDate(getLocalDate());
    setTaskDraft({ title: "", estimateMinutes: 60, priority: "medium", goalId: "" });
    setBlockDraft({ type: "task", taskId: "", title: "", start: (defaultState.settings.workSegments[0]?.start || "09:00"), end: "10:00" });
    setBreakdownDraft({ goalId: "", outcome: "", deadline: "", constraints: "" });
    setBreakdownSuggestions([]);
    setAiStatus({ loading: false, error: "", message: "本地数据已清空。" });
    setAiTaskSuggestions([]);
    setTodayAiReply("");
    setScheduleQuestions([]);
    setPlanningCoach({
      scope: "today",
      messages: [],
      input: "",
      suggestions: [],
      loading: false,
      error: "",
    });
    setReviewDraft({ completed: "", blockers: "", adjustments: "", tomorrowFocus: "" });
  }

  function importData(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        setPlanner(hydrateState(JSON.parse(String(reader.result || "{}"))));
      } catch {
        window.alert("导入失败：JSON 格式不正确。");
      }
    };
    reader.onerror = () => {
      window.alert("导入失败：文件读取错误。");
    };
    reader.readAsText(file);
    event.target.value = "";
  }

  function saveReview(event) {
    event.preventDefault();
    submitReviewForm(event.currentTarget);
  }

  function submitReviewForm(form) {
    const review = {
      completed: String(fieldValue(form, "completed", reviewDraft.completed || "")),
      blockers: String(fieldValue(form, "blockers", reviewDraft.blockers || "")),
      adjustments: String(fieldValue(form, "adjustments", reviewDraft.adjustments || "")),
      tomorrowFocus: String(fieldValue(form, "tomorrowFocus", reviewDraft.tomorrowFocus || "")),
    };
    patchPlanner((current) => {
      const reviews = current.reviews.filter((review) => !(review.date === selectedDate && review.type === "daily"));
      return {
        reviews: reviews.concat({
          id: uid("review"),
          type: "daily",
          date: selectedDate,
          ...review,
          createdAt: new Date().toISOString(),
        }),
        dayPlans: {
          ...current.dayPlans,
          [selectedDate]: {
            ...(current.dayPlans[selectedDate] || dayPlan),
            eveningDone: true,
          },
        },
      };
    });

    // async: update user profile via AI
    if (planner.ai.enabled && planner.ai.profileLearningEnabled) {
      updateProfileFromReview(review);
    }
  }

  async function updateProfileFromReview(review) {
    try {
      const profile = await fetch("/api/profile").then((r) => r.json()).catch(() => ({}));
      const result = await callPlanningAi({
        ai: planner.ai,
        serverKeyOk: serverAiKeyLoaded,
        maxTokens: 800,
        messages: [
          {
            role: "system",
            content: "你是 Plan Pilot 的画像分析师。根据复盘更新用户画像，仅返回 JSON：{\"workStyle\":\"...\",\"energyPattern\":\"...\",\"preferences\":\"...\",\"typicalDay\":\"...\",\"notes\":\"...\"}。每条 1-2 句话，增量更新保留已有有价值信息。",
          },
          {
            role: "user",
            content: JSON.stringify({
              currentProfile: profile,
              review: {
                date: selectedDate,
                completed: review.completed,
                blockers: review.blockers,
                adjustments: review.adjustments,
                tomorrowFocus: review.tomorrowFocus,
              },
            }),
          },
        ],
      });
      await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      });
    } catch (e) {
      console.error("updateProfileFromReview failed:", e);
    }
  }

  function carryUnfinished() {
    const tomorrow = addDays(selectedDate, 1);
    patchPlanner((current) => {
      const updatedTasks = current.tasks.map((task) =>
        task.date === selectedDate && task.status !== "done"
          ? { ...task, date: tomorrow, status: "open" }
          : task,
      );
      return {
        tasks: updatedTasks,
        blocks: current.blocks.filter(
          (block) => block.date !== selectedDate || updatedTasks.find((t) => t.id === block.taskId)?.status === "done",
        ),
      };
    });
    setSelectedDate(tomorrow);
  }

  return (
    <main className="app-shell">
      <aside className="rail">
        <span className="brand-mark" title={APP_NAME}>
          <Sparkles size={20} />
        </span>
        <nav className="rail-nav">
          <button className={activeView === "today" ? "active" : ""} title="今日" aria-label="今日" onClick={() => setActiveView("today")}>
            <CalendarDays size={20} />
          </button>
          <button className={activeView === "goals" ? "active" : ""} title="目标" aria-label="目标" onClick={() => setActiveView("goals")}>
            <Target size={20} />
          </button>
          <button className={activeView === "review" ? "active" : ""} title="复盘" aria-label="复盘" onClick={() => setActiveView("review")}>
            <ListChecks size={20} />
          </button>
        </nav>
        <button
          className={`rail-settings ${settingsOpen ? "active" : ""}`}
          title="设置"
          aria-label="设置"
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <Settings size={20} />
        </button>
      </aside>

      {settingsOpen && <div className="drawer-overlay" onClick={() => setSettingsOpen(false)} />}

      <aside className={`settings-drawer ${settingsOpen ? "open" : ""}`} aria-hidden={!settingsOpen}>
        <div className="drawer-head">
          <div className="brand">
            <span className="brand-mark">
              <Sparkles size={18} />
            </span>
            <div>
              <strong>{APP_NAME}</strong>
              <span>{formatHumanDate(getLocalDate())}</span>
            </div>
          </div>
          <button className="drawer-close" title="关闭" aria-label="关闭设置" onClick={() => setSettingsOpen(false)}>
            <X size={18} />
          </button>
        </div>

        <section className="settings-panel">
          <label className="theme-select" style={{ gridColumn: "1 / -1" }}>
            外观主题
            <select value={theme} onChange={(event) => setTheme(event.target.value)}>
              <option value="warm">暖象牙（默认）</option>
              <option value="cool">冷蓝清新</option>
              <option value="graphite">墨灰</option>
            </select>
          </label>
          <div className="work-segments-label">工作时段</div>
          {(planner.settings.workSegments || []).map((seg) => (
            <div className="work-segment-item" key={`${seg.start}-${seg.end}`}>
              <span>{seg.start} - {seg.end}</span>
              <button className="icon-button" onClick={() => {
                patchPlanner((current) => ({
                  settings: {
                    ...current.settings,
                    workSegments: current.settings.workSegments.filter((s) => s.start !== seg.start || s.end !== seg.end),
                  },
                }));
              }}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {(planner.settings.workSegments || []).length < 3 && (
            <button className="compact-action" onClick={() => {
              setSegmentDraft({ start: "09:00", end: "12:00" });
              setShowSegmentModal(true);
            }}>
              <Plus size={14} />
              添加时段
            </button>
          )}

          {showSegmentModal && (
            <div className="modal-overlay" onClick={() => setShowSegmentModal(false)}>
              <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                <h3>添加工作时段</h3>
                <div className="modal-row">
                  <label>开始 <input type="time" lang="zh-CN" value={segmentDraft.start}
                    onChange={(e) => setSegmentDraft((d) => ({ ...d, start: e.target.value }))} /></label>
                  <label>结束 <input type="time" lang="zh-CN" value={segmentDraft.end}
                    onChange={(e) => setSegmentDraft((d) => ({ ...d, end: e.target.value }))} /></label>
                </div>
                <div className="modal-actions">
                  <button className="secondary-action" onClick={() => setShowSegmentModal(false)}>取消</button>
                  <button className="primary-action" onClick={() => {
                    const newDur = toMinutes(segmentDraft.end) - toMinutes(segmentDraft.start);
                    if (newDur <= 0) return;
                    const currentTotal = workloadMinutes(planner.settings);
                    if (currentTotal + newDur > 600) { window.alert("总工作时长不能超过 10 小时。"); return; }
                    patchPlanner((current) => ({
                      settings: {
                        ...current.settings,
                        workSegments: [...(current.settings.workSegments || []), { start: segmentDraft.start, end: segmentDraft.end }]
                          .sort((a, b) => toMinutes(a.start) - toMinutes(b.start)),
                      },
                    }));
                    setShowSegmentModal(false);
                  }}>确认添加</button>
                </div>
              </div>
            </div>
          )}
          <label>
            短休息 (分钟)
            <input
              type="number"
              min="0"
              max="30"
              value={planner.settings.shortBreak}
              onChange={(event) =>
                patchPlanner((current) => ({
                  settings: { ...current.settings, shortBreak: Number(event.target.value) },
                }))
              }
            />
          </label>
          <label>
            长休息 (分钟)
            <input
              type="number"
              min="0"
              max="60"
              value={planner.settings.longBreak}
              onChange={(event) =>
                patchPlanner((current) => ({
                  settings: { ...current.settings, longBreak: Number(event.target.value) },
                }))
              }
            />
          </label>
        </section>

        <section className="recurring-panel">
          <p className="recurring-label">周期安排</p>
          {(planner.recurring || []).map((r) => (
            <div className="recurring-item" key={r.id}>
              <span>
                {r.title} · 周{dayNames[r.dayOfWeek]} {r.start}-{r.end}
                {r.endDate ? ` 至 ${r.endDate}` : ""}
              </span>
              <button className="icon-button" onClick={() => {
                setEditingRecurringId(r.id);
                setRecurringDraft({ title: r.title, start: r.start, end: r.end, dayOfWeek: r.dayOfWeek, endDate: r.endDate || "" });
                setShowRecurringModal(true);
              }}>
                <Pencil size={14} />
              </button>
            </div>
          ))}
          <div className="recurring-add-row">
            <input
              value={quickRecurringTitle}
              onChange={(e) => setQuickRecurringTitle(e.target.value)}
              placeholder="例如：组会"
            />
            <button className="compact-action solid" onClick={() => {
              setEditingRecurringId(null);
              setRecurringDraft({ title: quickRecurringTitle, start: "09:00", end: "10:00", dayOfWeek: 1, endDate: "" });
              setQuickRecurringTitle("");
              setShowRecurringModal(true);
            }}>
              <Plus size={16} />
            </button>
          </div>
        </section>

        {showRecurringModal && (
          <div className="modal-overlay" onClick={() => setShowRecurringModal(false)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <h3>{editingRecurringId ? "编辑周期安排" : "添加周期安排"}</h3>
              <label>
                名称
                <input
                  value={recurringDraft.title}
                  onChange={(e) => setRecurringDraft((d) => ({ ...d, title: e.target.value }))}
                  placeholder="例如：组会"
                />
              </label>
              <div className="modal-row">
                <label>
                  开始
                  <input type="time" lang="zh-CN" value={recurringDraft.start}
                    onChange={(e) => setRecurringDraft((d) => ({ ...d, start: e.target.value }))} />
                </label>
                <label>
                  结束
                  <input type="time" lang="zh-CN" value={recurringDraft.end}
                    onChange={(e) => setRecurringDraft((d) => ({ ...d, end: e.target.value }))} />
                </label>
              </div>
              <label>
                星期
                <select value={recurringDraft.dayOfWeek}
                  onChange={(e) => setRecurringDraft((d) => ({ ...d, dayOfWeek: Number(e.target.value) }))}>
                  {dayNames.map((name, i) => (
                    <option key={i} value={i}>周{name}</option>
                  ))}
                </select>
              </label>
              <label>
                结束日期（可选）
                <input type="date" value={recurringDraft.endDate}
                  onChange={(e) => setRecurringDraft((d) => ({ ...d, endDate: e.target.value }))} />
              </label>
              <div className="modal-actions">
                {editingRecurringId && (
                  <button className="secondary-action" style={{ marginRight: "auto", color: "#b83b2c", borderColor: "#b83b2c" }} onClick={() => {
                    deleteRecurring(editingRecurringId);
                    setShowRecurringModal(false);
                    setEditingRecurringId(null);
                  }}>删除</button>
                )}
                <button className="secondary-action" onClick={() => { setShowRecurringModal(false); setEditingRecurringId(null); }}>取消</button>
                <button className="primary-action" onClick={() => {
                  if (!recurringDraft.title.trim()) return;
                  const editId = editingRecurringId;
                  patchPlanner((current) => {
                    const recurring = (current.recurring || [])
                      .filter((item) => !editId || item.id !== editId)
                      .concat({ id: editId || uid("rec"), ...recurringDraft });
                    return { recurring, blocks: replaceRecurringBlocks(recurring, current.blocks) };
                  });
                  setRecurringDraft({ title: "", start: "09:00", end: "10:00", dayOfWeek: 1, endDate: "" });
                  setShowRecurringModal(false);
                  setEditingRecurringId(null);
                }}>{editingRecurringId ? "保存修改" : "确认添加"}</button>
              </div>
            </div>
          </div>
        )}

        <section className="ai-panel">
          <label className="ai-toggle">
            <input
              type="checkbox"
              checked={planner.ai.enabled}
              onChange={(event) => updateAiSettings({ enabled: event.target.checked })}
            />
            启用 AI 辅助
          </label>
          <label>
            服务商
            <select value={planner.ai.provider} onChange={(event) => applyAiProviderPreset(event.target.value)}>
              {Object.entries(AI_PROVIDER_PRESETS).map(([value, preset]) => (
                <option key={value} value={value}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            API Key
            <input
              type="password"
              value={localAiKey}
              onChange={(event) => updateLocalAiKey(event.target.value)}
              placeholder={serverAiKeyLoaded ? "已从本机环境变量加载" : "填写你自己的 API Key"}
              autoComplete="off"
            />
            <span className={`key-status ${aiKeyLoaded ? "loaded" : "missing"}`}>
              {aiKeyLoaded ? "已加载" : "未配置"}
            </span>
          </label>
          <details className="ai-advanced">
            <summary>高级设置</summary>
            <label>
              模型
              <input
                value={planner.ai.model}
                onChange={(event) => updateAiSettings({ model: event.target.value })}
                placeholder={currentAiPreset.model || "model-id"}
              />
            </label>
            <label>
              API 地址
              <input
                value={planner.ai.baseUrl}
                onChange={(event) => updateAiSettings({ baseUrl: event.target.value })}
                placeholder={currentAiPreset.baseUrl || "https://api.example.com/v1"}
              />
            </label>
            <label className="ai-toggle">
              <input
                type="checkbox"
                checked={Boolean(planner.ai.profileLearningEnabled)}
                onChange={(event) => updateAiSettings({ profileLearningEnabled: event.target.checked })}
              />
              允许 AI 根据复盘更新本地画像
            </label>
          </details>
          <p>
            当前协议：{planner.ai.protocol === "anthropic" ? "Anthropic Messages" : "OpenAI 兼容"}。
            {serverAiKeyLoaded
              ? "已检测到服务端环境变量（AI_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY），Key 不会持久化到服务器或数据文件中。如需改用浏览器 Key，清空环境变量后在上方输入框填写即可。"
              : localAiKey.trim()
                ? "浏览器 Key 存储在本地 localStorage，每次调用随请求临时传入本机代理，不会持久化到服务器或数据文件中。如需切换为服务端 Key，可配置环境变量（AI_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY）或项目根目录 .env 文件，然后清空上方输入框。"
                : "Key 可填写在上方输入框（存储在浏览器 localStorage），也可通过服务端环境变量（AI_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY）或项目根目录 .env 文件配置。"}
          </p>
          {currentAiPreset.note && <p className="ai-provider-note">{currentAiPreset.note}</p>}
        </section>

        <section className="data-panel">
          <button onClick={exportData}>
            <Download size={16} />
            导出 JSON
          </button>
          <label>
            <Upload size={16} />
            导入 JSON
            <input type="file" accept="application/json" onChange={importData} />
          </label>
          <button className="danger-data" onClick={resetLocalData}>
            <Trash2 size={16} />
            清空本地数据
          </button>
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{activeView === "today" ? "今日引导" : activeView === "goals" ? "目标层级" : "收束调整"}</p>
            <h1>{viewHeadline}</h1>
            {activeView === "today" && (
              <div className="topbar-highlights">
                {upcomingHighlights.busy && (
                  <span className="topbar-highlight busy" title={upcomingHighlights.busy.title}>
                    <Clock3 size={12} />
                    {upcomingHighlights.busy.title.length > 12
                      ? upcomingHighlights.busy.title.slice(0, 12) + "..."
                      : upcomingHighlights.busy.title}
                    {" "}{formatShortDate(upcomingHighlights.busy.date)}
                  </span>
                )}
                {upcomingHighlights.week && (
                  <span className="topbar-highlight week" title={upcomingHighlights.week.title}>
                    <Target size={12} />
                    {upcomingHighlights.week.parentTitle
                      ? (upcomingHighlights.week.parentTitle.length > 8 ? upcomingHighlights.week.parentTitle.slice(0, 8) + "… › " : upcomingHighlights.week.parentTitle + " › ")
                      : ""}
                    {upcomingHighlights.week.title}
                  </span>
                )}
                {upcomingHighlights.month && (
                  <span className="topbar-highlight month" title={upcomingHighlights.month.title}>
                    <Target size={12} />
                    {upcomingHighlights.month.parentTitle
                      ? (upcomingHighlights.month.parentTitle.length > 8 ? upcomingHighlights.month.parentTitle.slice(0, 8) + "… › " : upcomingHighlights.month.parentTitle + " › ")
                      : ""}
                    {upcomingHighlights.month.title}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="date-switcher">
            <button title="前一天" onClick={() => setSelectedDate(addDays(selectedDate, -1))}>
              <ChevronRight className="flip" size={18} />
            </button>
            <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
            <button title="后一天" onClick={() => setSelectedDate(addDays(selectedDate, 1))}>
              <ChevronRight size={18} />
            </button>
          </div>
        </header>

        <ErrorBoundary>
        {activeView === "today" && (
          <TodayView
            planner={planner}
            dayPlan={dayPlan}
            selectedDate={selectedDate}
            todayTasks={todayTasks}
            todayBlocks={todayBlocks}
            activeGoals={activeGoals}
            taskById={taskById}
            goalById={goalById}
            taskDraft={taskDraft}
            blockDraft={blockDraft}
            plannedMinutes={plannedMinutes}
            scheduledMinutes={scheduledMinutes}
            workMinutes={availableMinutes}
            completedCount={completedCount}
            setTaskDraft={setTaskDraft}
            setBlockDraft={setBlockDraft}
            updateDayPlan={updateDayPlan}
            saveMorningPlan={saveMorningPlan}
            addTask={addTask}
            submitTaskForm={submitTaskForm}
            updateTask={updateTask}
            deferTask={deferTask}
            deferTaskTo={deferTaskTo}
            deleteTask={deleteTask}
            autoSchedule={autoSchedule}
            schedulePreview={schedulePreview}
            scheduleUndo={scheduleUndo}
            confirmSchedulePreview={confirmSchedulePreview}
            cancelSchedulePreview={cancelSchedulePreview}
            undoSchedule={undoSchedule}
            scheduleNotice={scheduleNotice}
            setScheduleNotice={setScheduleNotice}
            scheduleQuestions={scheduleQuestions}
            setScheduleQuestions={setScheduleQuestions}
            addManualBlock={addManualBlock}
            submitBlockForm={submitBlockForm}
            addBlockDirectly={addBlockDirectly}
            deleteBlock={deleteBlock}
            updateBlock={updateBlock}
            applyDragReschedule={applyDragReschedule}
            scheduleTaskAtMinute={scheduleTaskAtMinute}
            aiStatus={aiStatus}
            aiTaskSuggestions={aiTaskSuggestions}
            generateTodayAiGuide={generateTodayAiGuide}
            acceptAiTaskSuggestions={acceptAiTaskSuggestions}
            planningCoach={planningCoach}
            setPlanningCoach={setPlanningCoach}
            startPlanningCoach={startPlanningCoach}
            sendPlanningCoachMessage={sendPlanningCoachMessage}
            acceptPlanningCoachSuggestions={acceptPlanningCoachSuggestions}
            showAiFollowUp={showAiFollowUp}
            todayAiReply={todayAiReply}
            setTodayAiReply={setTodayAiReply}
            sendTodayAiReply={sendTodayAiReply}
          />
        )}

        {activeView === "goals" && (
          <GoalsView
            goals={planner.goals}
            tasks={planner.tasks}
            selectedDate={selectedDate}
            goalDraft={goalDraft}
            setGoalDraft={setGoalDraft}
            addGoal={addGoal}
            submitGoalForm={submitGoalForm}
            updateGoal={updateGoal}
            deleteGoal={deleteGoal}
            breakdownDraft={breakdownDraft}
            setBreakdownDraft={setBreakdownDraft}
            breakdownSuggestions={breakdownSuggestions}
            generateBreakdown={generateBreakdown}
            acceptBreakdown={acceptBreakdown}
            aiStatus={aiStatus}
            goalById={goalById}
          />
        )}

        {activeView === "review" && (
          <ReviewView
            selectedDate={selectedDate}
            todayTasks={todayTasks}
            dayPlan={dayPlan}
            reviewDraft={reviewDraft}
            setReviewDraft={setReviewDraft}
            saveReview={saveReview}
            submitReviewForm={submitReviewForm}
            carryUnfinished={carryUnfinished}
            reviews={planner.reviews}
          />
        )}
        </ErrorBoundary>
      </section>
    </main>
  );
}

function DayTimeline({ blocks, taskById, settings, selectedDate, onReschedule, onDropTask, onEdit, onDelete, onToggleDone }) {
  const PXH = 56; // 每小时像素
  const ppm = PXH / 60;
  const segs = settings.workSegments || [];
  const hasContent = segs.length > 0 || blocks.length > 0; // 是否有可显示内容（否则给空态提示）
  const [drag, setDrag] = useState(null); // { id, mode:"move"|"resize", startY, origStart, origEnd, deltaMin }
  const rootRef = useRef(null); // 容器，用于把落点 clientY 换算成分钟
  const [dropMin, setDropMin] = useState(null); // 外部任务拖入时的落点指示（分钟）

  useEffect(() => {
    if (!drag) return undefined;
    function onMove(e) {
      const deltaMin = Math.round((e.clientY - drag.startY) / ppm / 5) * 5; // 吸附 5 分钟
      setDrag((d) => (d ? { ...d, deltaMin } : d));
    }
    function onUp() {
      setDrag((d) => {
        if (d && d.deltaMin) {
          const dur = d.origEnd - d.origStart;
          if (d.mode === "resize") {
            onReschedule(d.id, d.origStart, Math.max(d.origStart + 15, d.origEnd + d.deltaMin));
          } else {
            onReschedule(d.id, d.origStart + d.deltaMin, d.origStart + d.deltaMin + dur);
          }
        }
        return null;
      });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag?.id, drag?.mode]);

  // 全天 0–24 较高、容器内部滚动；切换日期/进入时自动定位到「现在」（非今天则定位到首个块/工作开始），
  // 让关注点上方留约 1 小时，避免一进来停在凌晨空白区。
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const now = new Date();
    const focusMin =
      selectedDate === getLocalDate()
        ? now.getHours() * 60 + now.getMinutes()
        : blocks.length
          ? Math.min(...blocks.map((b) => toMinutes(b.start)))
          : segs[0]
            ? toMinutes(segs[0].start)
            : 8 * 60;
    el.scrollTop = Math.max(0, (focusMin - 60) * ppm);
  }, [selectedDate]);

  if (!hasContent) {
    return <EmptyState icon={<Clock3 size={22} />} text="还没有时间块。先在设置里配置工作时段，或在上面加任务后点自动安排。" />;
  }
  // 固定显示完整一天 00:00–24:00：小时标签 0–23（最后一格 23:00），容器高度铺到 24:00，
  // 这样「现在」线在任何时刻（含 23:xx）都落在范围内、不会越出底部看不见。
  const dayStart = 0;
  const dayEnd = 1440;
  const totalMin = dayEnd - dayStart;
  const hours = [];
  for (let m = dayStart; m < dayEnd; m += 60) hours.push(m);
  const nowDate = new Date();
  const nowMin = selectedDate === getLocalDate() ? nowDate.getHours() * 60 + nowDate.getMinutes() : null;

  function startDrag(e, block, mode) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    setDrag({ id: block.id, mode, startY: e.clientY, origStart: toMinutes(block.start), origEnd: toMinutes(block.end), deltaMin: 0 });
  }

  // 把落点 clientY 换算成分钟（减去顶部 8px padding，吸附 5 分钟，夹在当天范围内）
  function yToMinute(clientY) {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return dayStart;
    const m = dayStart + (clientY - rect.top - 8) / ppm;
    return Math.max(dayStart, Math.min(dayEnd, Math.round(m / 5) * 5));
  }
  function onDragOverTimeline(e) {
    if (!onDropTask) return;
    e.preventDefault(); // 必须 preventDefault 才能触发 drop
    e.dataTransfer.dropEffect = "copy";
    setDropMin(yToMinute(e.clientY));
  }
  function onDropTimeline(e) {
    if (!onDropTask) return;
    e.preventDefault();
    const taskId = e.dataTransfer.getData("text/plain");
    const minute = yToMinute(e.clientY);
    setDropMin(null);
    if (taskId) onDropTask(taskId, minute);
  }

  return (
    <div
      className="day-timeline"
      ref={rootRef}
      style={{}} // height determined by flex layout; inner spacer keeps 24h canvas
      onDragOver={onDragOverTimeline}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDropMin(null); }}
      onDrop={onDropTimeline}
    >
      {hours.map((m) => (
        <div className="dt-hour" key={m} style={{ top: (m - dayStart) * ppm + 8 }}>
          <span>{toTime(m)}</span>
        </div>
      ))}
      {blocks.map((block) => {
        const task = taskById[block.taskId];
        const busy = block.type === "busy" || (!block.taskId && !block.auto);
        const title = task?.title || block.title || (busy ? "固定占用" : "自定义安排");
        const isDragging = drag?.id === block.id;
        const dMove = isDragging && drag.mode === "move" ? drag.deltaMin : 0;
        const dResize = isDragging && drag.mode === "resize" ? drag.deltaMin : 0;
        const startMin = toMinutes(block.start) + dMove;
        const endMin = toMinutes(block.end) + dMove + dResize;
        const top = (startMin - dayStart) * ppm + 8;
        const h = Math.max(30, (endMin - startMin) * ppm);
        let cls = "deep";
        if (busy) cls = isMeetingSentence(title) ? "meet" : "busy";
        else if (task?.kind === "fixed") cls = "meet";
        else if (task?.priority === "high") cls = "priority-high";
        else if (task?.priority === "medium") cls = "priority-medium";
        else if (task?.priority === "low") cls = "priority-low";
        const col = block._col ?? 0;
        const cols = block._totalCols ?? 1;
        // When overlapping, shift left/width so blocks render side-by-side.
        // Single blocks keep the original full-width layout (right: 2px).
        const blkStyle = cols > 1
          ? {
              top,
              height: h,
              left: `calc(50px + (100% - 52px) * ${col / cols})`,
              width: `calc((100% - 52px) / ${cols} - 2px)`,
              right: "auto",
            }
          : { top, height: h };
        return (
          <article
            className={`dt-blk dt-${cls}${isDragging ? " dragging" : ""}${task?.status === "done" ? " dt-done" : ""}`}
            key={block.id}
            style={blkStyle}
            onPointerDown={(e) => startDrag(e, block, "move")}
          >
            {!busy && block.taskId && task && onToggleDone && (
              <button
                type="button"
                className={`dt-check${task.status === "done" ? " is-done" : ""}`}
                role="checkbox"
                aria-checked={task.status === "done"}
                aria-label={task.status === "done" ? "标记未完成" : "标记完成"}
                title={task.status === "done" ? "标记未完成" : "标记完成"}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onToggleDone(block); }}
              >
                {task.status === "done" ? <CheckSquare size={16} /> : <Square size={16} />}
              </button>
            )}
            <div className="dt-body">
              <div className="dt-bt">{title}</div>
              <div className="dt-bm">
                {toTime(startMin)}–{toTime(endMin)} · {endMin - startMin}分钟
                {busy ? " · 不可用" : block.auto ? " · 自动" : ""}
              </div>
            </div>
            <div className="dt-actions">
              <button title="编辑" onPointerDown={(e) => e.stopPropagation()} onClick={() => onEdit(block)}>
                <Pencil size={14} />
              </button>
              <button title="删除" onPointerDown={(e) => e.stopPropagation()} onClick={() => onDelete(block.id)}>
                <Trash2 size={14} />
              </button>
            </div>
            <div
              className="dt-resize"
              title="拖动改时长"
              onPointerDown={(e) => {
                e.stopPropagation();
                startDrag(e, block, "resize");
              }}
            />
          </article>
        );
      })}
      {nowMin != null && nowMin >= dayStart && nowMin <= dayEnd && (
        <div className="dt-now" style={{ top: (nowMin - dayStart) * ppm + 8 }}>
          <b>现在 {toTime(nowMin)}</b>
        </div>
      )}
      {dropMin != null && (
        <div className="dt-drop" style={{ top: (dropMin - dayStart) * ppm + 8 }}>
          <b>放到 {toTime(dropMin)}</b>
        </div>
      )}
      <div className="dt-spacer" style={{ height: totalMin * ppm + 18, pointerEvents: "none" }} />
    </div>
  );
}

function TodayView({
  planner,
  dayPlan,
  selectedDate,
  todayTasks,
  todayBlocks,
  activeGoals,
  taskById,
  goalById,
  taskDraft,
  blockDraft,
  plannedMinutes,
  scheduledMinutes,
  workMinutes,
  completedCount,
  setTaskDraft,
  setBlockDraft,
  updateDayPlan,
  saveMorningPlan,
  addTask,
  submitTaskForm,
  updateTask,
  deferTask,
  deferTaskTo,
  deleteTask,
  autoSchedule,
  schedulePreview,
  scheduleUndo,
  confirmSchedulePreview,
  cancelSchedulePreview,
  undoSchedule,
  scheduleNotice,
  setScheduleNotice,
  scheduleQuestions,
  setScheduleQuestions,
  addManualBlock,
  submitBlockForm,
  addBlockDirectly,
  deleteBlock,
  updateBlock,
  applyDragReschedule,
  scheduleTaskAtMinute,
  aiStatus,
  aiTaskSuggestions,
  generateTodayAiGuide,
  acceptAiTaskSuggestions,
  planningCoach,
  setPlanningCoach,
  startPlanningCoach,
  sendPlanningCoachMessage,
  acceptPlanningCoachSuggestions,
  showAiFollowUp,
  todayAiReply,
  setTodayAiReply,
  sendTodayAiReply,
}) {
  const overload = plannedMinutes > workMinutes;
  const futureTasks = useMemo(() =>
    planner.tasks
      .filter((t) => t.date > selectedDate && t.status !== "done")
      .sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority])
      .slice(0, 2),
    [planner.tasks, selectedDate],
  );
  // 逾期未完成：早于当前日期、仍未完成的任务（否则它们会从「今日」视图里彻底消失、被遗忘）
  const overdueTasks = useMemo(() =>
    planner.tasks
      .filter((t) => t.date < selectedDate && t.status !== "done")
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : priorityOrder[b.priority] - priorityOrder[a.priority])),
    [planner.tasks, selectedDate],
  );
  const [deferringTaskId, setDeferringTaskId] = useState(null);
  const [deferTaskDate, setDeferTaskDate] = useState("");
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [editDraft, setEditDraft] = useState({ title: "", estimateMinutes: 60, priority: "medium", goalId: "" });
  const [editingBlockId, setEditingBlockId] = useState(null);
  const [deferringQuestionId, setDeferringQuestionId] = useState(null);
  const [deferTargetDate, setDeferTargetDate] = useState("");
  const [blockEditDraft, setBlockEditDraft] = useState({ title: "", start: "09:00", end: "10:00", type: "task" });

  function startEditingBlock(block) {
    setEditingBlockId(block.id);
    setBlockEditDraft({
      title: block.title || "",
      start: block.start,
      end: block.end,
      type: block.type || "task",
    });
  }

  function cancelEditingBlock() {
    setEditingBlockId(null);
  }

  function saveEditingBlock(blockId) {
    updateBlock(blockId, {
      title: blockEditDraft.title.trim(),
      start: blockEditDraft.start,
      end: blockEditDraft.end,
      type: blockEditDraft.type,
    });
    setEditingBlockId(null);
  }

  function startEditingTask(task) {
    setEditingTaskId(task.id);
    setEditDraft({
      title: task.title,
      estimateMinutes: Number(task.estimateMinutes) || 60,
      priority: task.priority,
      goalId: task.goalId || "",
    });
  }

  function fillScheduleQuestion(question) {
    const task = planner.tasks.find((t) => t.id === question.taskId) || {
      title: question.title,
      estimateMinutes: question.estimateMinutes,
    };
    const minutes = Math.max(10, Number(task.estimateMinutes) || Number(question.estimateMinutes) || 30);
    const name = task.title || question.title || "这个任务";
    // 购票类时间歧义：不自动放置，交给用户在表单里确认买票的执行时间。
    if (isTicketPurchaseTask(task.title) && !parseTimeInSentence(task.title)) {
      setBlockDraft((draft) => ({ ...draft, type: "task", taskId: question.taskId, title: "" }));
      setScheduleNotice({ text: `「${name}」标题里的时间更像车次/出发时间。已填好下方表单，请手动选你真正要执行的时间再添加。`, tone: "info" });
      return;
    }
    const slot = findSlotForTask(task, planner.settings, todayBlocks, selectedDate);
    if (slot && addBlockDirectly({ type: "task", taskId: question.taskId, title: "", start: slot.start, end: slot.end })) {
      setScheduleQuestions((qs) => qs.filter((q) => q.id !== question.id));
      setScheduleNotice({ text: `已把「${name}」放到 ${slot.start}–${slot.end}。`, tone: "info" });
      return;
    }
    // 放不下：明确说明原因和可行的下一步，而不是静默地只填个表单。
    setBlockDraft((draft) => ({ ...draft, type: "task", taskId: question.taskId, title: "" }));
    setScheduleNotice({
      text: `今天剩余空档放不下「${name}」（需 ${minutes} 分钟连续时间）。可以：① 拆成更小的步骤分别安排；② 点「延期」改到其他日期；③ 先删掉或缩短当天某个时间块腾出连续时间。已填好下方表单，也可手动指定时间。`,
      tone: "error",
    });
  }

  function cancelEditingTask() {
    setEditingTaskId(null);
  }

  function saveEditingTask(taskId) {
    if (!editDraft.title.trim()) return;
    updateTask(taskId, {
      title: editDraft.title.trim(),
      estimateMinutes: Number(editDraft.estimateMinutes) || 30,
      priority: editDraft.priority,
      goalId: editDraft.goalId || "",
    });
    setEditingTaskId(null);
  }

  return (
    <div className="cockpit-grid">
      <section className="coach-band">
        <div className="coach-copy">
          <div>
            <p className="eyebrow">晨间问题</p>
            <h2 style={{ color: energyColor(dayPlan.energy) }}>{formatHumanDate(selectedDate)}</h2>
          </div>
          <select
            className="energy-select"
            value={dayPlan.energy}
            onChange={(event) => updateDayPlan({ energy: event.target.value })}
            aria-label="今日精力"
          >
            {energyOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        <div className="question-grid">
          <label>
            固定安排
            <textarea
              value={dayPlan.fixed}
              onChange={(event) => updateDayPlan({ fixed: event.target.value })}
              placeholder="会议、通勤、已经约定的事"
            />
          </label>
          <label>
            今日最重要
            <textarea
              value={dayPlan.topThree}
              onChange={(event) => updateDayPlan({ topThree: event.target.value })}
              placeholder="最多写 1-3 件"
            />
          </label>
          <label>
            变化与风险
            <textarea
              value={dayPlan.changes}
              onChange={(event) => updateDayPlan({ changes: event.target.value })}
              placeholder="会影响本周、本月或长期目标的情况"
            />
          </label>
        </div>
        <div className="morning-actions">
          <button className="primary-action" onClick={saveMorningPlan}>
            <CheckCircle2 size={18} />
            保存
          </button>
          <button className="secondary-action" onClick={generateTodayAiGuide} disabled={aiStatus.loading}>
            <Sparkles size={18} />
            {aiStatus.loading ? "AI 思考中" : "今日建议"}
          </button>
        </div>
        {aiStatus.message && <span className="ai-message">{aiStatus.message}</span>}
        {aiStatus.error && <span className="ai-error">{aiStatus.error}</span>}
        {showAiFollowUp && (
          <form className="ai-followup-form" onSubmit={sendTodayAiReply}>
            <textarea
              value={todayAiReply}
              onChange={(event) => setTodayAiReply(event.target.value)}
              placeholder="回答 AI 的问题，或继续补充今天想推进的事（也可以是想做但一时难拆解的需求）；没有更多就回复“没有了”结束本轮。"
            />
            <div className="ai-followup-actions">
              <button className="secondary-action" disabled={!todayAiReply.trim()}>
                <Send size={18} />
                发送并继续
              </button>
            </div>
          </form>
        )}
        {aiTaskSuggestions.length > 0 && (
          <div className="ai-suggestion-list">
            {aiTaskSuggestions.map((task) => (
              <article className="ai-suggestion" key={task.id}>
                <strong>{task.title}</strong>
                <span>
                  {priorityLabel[task.priority]}优先级 · {task.estimateMinutes} 分钟
                  {task.reason ? ` · ${task.reason}` : ""}
                </span>
              </article>
            ))}
            <button className="primary-action" onClick={acceptAiTaskSuggestions}>
              <Plus size={18} />
              加入今日任务
            </button>
          </div>
        )}
      </section>

      <section className="panel interview-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">AI 规划访谈</p>
            <h2>让模型主动问，再帮你拆</h2>
          </div>
          <select
            value={planningCoach.scope}
            onChange={(event) =>
              setPlanningCoach((coach) => ({
                ...coach,
                scope: event.target.value,
                messages: [],
                suggestions: [],
                error: "",
              }))
            }
          >
            <option value="today">今天</option>
            <option value="week">本周</option>
            <option value="month">月度</option>
            <option value="long">长期</option>
          </select>
        </div>

        <div className="interview-body">
          {planningCoach.messages.length > 0 && (
            <div className="interview-messages">
              {planningCoach.messages.map((message, index) => (
                <article className={`interview-message ${message.role}`} key={`${message.role}-${index}`}>
                  {message.content}
                </article>
              ))}
            </div>
          )}

          {planningCoach.error && <div className="ai-error block">{planningCoach.error}</div>}

          {planningCoach.suggestions.length > 0 && (
            <div className="coach-suggestions">
              {planningCoach.suggestions.map((item) => (
                <article className="coach-suggestion" key={item.id}>
                  <strong>{item.title}</strong>
                  <span>
                    {item.kind === "goal"
                      ? `${goalTypeLabel[item.type]}目标 · ${priorityLabel[item.priority]}优先级`
                      : item.kind === "busy"
                        ? `${item.start}-${item.end} · 固定安排`
                        : `${item.date} · ${item.estimateMinutes} 分钟 · ${priorityLabel[item.priority]}优先级`}
                  </span>
                </article>
              ))}
              <button className="primary-action" onClick={acceptPlanningCoachSuggestions}>
                <Plus size={18} />
                加入计划
              </button>
            </div>
          )}
        </div>

        <form className="interview-form" onSubmit={sendPlanningCoachMessage}>
          <textarea
            value={planningCoach.input}
            onChange={(event) => setPlanningCoach((coach) => ({ ...coach, input: event.target.value }))}
            placeholder="回答 AI 的问题，或直接描述：今天/本周/月度/长期想推进什么"
          />
          <div className="interview-actions">
            <button className="primary-action" disabled={planningCoach.loading || !planningCoach.input.trim()}>
              <Send size={18} />
              发送
            </button>
            <button type="button" className="secondary-action" onClick={startPlanningCoach} disabled={planningCoach.loading}>
              <Sparkles size={18} />
              {planningCoach.loading ? "AI 思考中" : "开始访谈"}
            </button>
          </div>
        </form>
      </section>

      <section className="stats-row">
        <Metric label="完成/总数" value={`${completedCount}/${todayTasks.length}`} />
        <Metric label="预计" value={`${plannedMinutes} 分钟`} tone={overload ? "danger" : ""} />
        <Metric label="已排" value={`${scheduledMinutes} 分钟`} />
        <Metric label="可用" value={`${workMinutes} 分钟`} />
      </section>

      <section className="panel task-panel">
        <div className="section-heading">
          <div>
            <h2>今天要做什么</h2>
          </div>
        </div>
        <form className="task-form" onSubmit={addTask}>
          <input
            name="title"
            value={taskDraft.title}
            onChange={(event) => setTaskDraft((draft) => ({ ...draft, title: event.target.value }))}
            placeholder="输入一个新任务"
          />
          <input
            name="estimateMinutes"
            type="number"
            min="10"
            step="10"
            value={taskDraft.estimateMinutes}
            onChange={(event) => setTaskDraft((draft) => ({ ...draft, estimateMinutes: event.target.value }))}
            aria-label="预计分钟"
          />
          <select
            name="priority"
            value={taskDraft.priority}
            onChange={(event) => setTaskDraft((draft) => ({ ...draft, priority: event.target.value }))}
            aria-label="优先级"
          >
            <option value="high">高优先级</option>
            <option value="medium">中优先级</option>
            <option value="low">低优先级</option>
          </select>
          <select
            name="goalId"
            value={taskDraft.goalId}
            onChange={(event) => setTaskDraft((draft) => ({ ...draft, goalId: event.target.value }))}
            aria-label="关联目标"
          >
            <option value="">不关联目标</option>
            {activeGoals.map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goalTypeLabel[goal.type]} · {goal.title}
              </option>
            ))}
          </select>
          <button
            type="submit"
            title="添加任务"
            className="compact-action solid"
            onClick={(event) => {
              event.preventDefault();
              submitTaskForm(event.currentTarget.form);
            }}
          >
            <Plus size={18} />
            添加
          </button>
        </form>

        <div className="task-list">
          {overdueTasks.length > 0 && (
            <div className="overdue-zone">
              <div className="overdue-head">
                <Clock3 size={14} />
                逾期未完成 · {overdueTasks.length}
              </div>
              {overdueTasks.map((task) => (
                <article className="overdue-item" key={task.id}>
                  <div className="overdue-main">
                    <strong>{task.title}</strong>
                    <span className="overdue-meta">
                      原定 {formatShortDate(task.date)} · {priorityLabel[task.priority]} · {task.estimateMinutes} 分钟
                    </span>
                  </div>
                  <div className="overdue-actions">
                    <button className="icon-button solid" title="顺延到今天" onClick={() => deferTaskTo(task.id, selectedDate)}>
                      <Plus size={16} />
                    </button>
                    <button
                      className="icon-button"
                      title="改到指定日期"
                      onClick={() => {
                        setDeferringTaskId((id) => (id === task.id ? null : task.id));
                        setDeferTaskDate(addDays(selectedDate, 1));
                      }}
                    >
                      <CalendarDays size={16} />
                    </button>
                    <button className="icon-button danger" title="删除任务" onClick={() => deleteTask(task.id)}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                  {deferringTaskId === task.id && (
                    <div className="defer-picker">
                      <input type="date" value={deferTaskDate} onChange={(e) => setDeferTaskDate(e.target.value)} />
                      <button
                        className="primary-action"
                        onClick={() => {
                          if (deferTaskDate) deferTaskTo(task.id, deferTaskDate);
                          setDeferringTaskId(null);
                        }}
                      >
                        确认
                      </button>
                      <button className="secondary-action" onClick={() => setDeferringTaskId(null)}>取消</button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
          {todayTasks.length === 0 && <EmptyState icon={<Target size={22} />} text="先写下今天的一件具体工作。" />}
          {todayTasks
            .sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority])
            .map((task) => {
              const isEditing = editingTaskId === task.id;
              const parentGoal = task.goalId && goalById[task.goalId];

              if (isEditing) {
                return (
                  <article className="task-item editing" key={task.id}>
                    <div className="edit-task-form">
                      <input
                        value={editDraft.title}
                        onChange={(e) => setEditDraft((d) => ({ ...d, title: e.target.value }))}
                        placeholder="任务标题"
                      />
                      <div className="edit-task-row">
                        <input
                          type="number"
                          min="10"
                          step="10"
                          value={editDraft.estimateMinutes}
                          onChange={(e) => setEditDraft((d) => ({ ...d, estimateMinutes: Number(e.target.value) }))}
                          aria-label="预计分钟"
                        />
                        <select
                          value={editDraft.priority}
                          onChange={(e) => setEditDraft((d) => ({ ...d, priority: e.target.value }))}
                          aria-label="优先级"
                        >
                          <option value="high">高</option>
                          <option value="medium">中</option>
                          <option value="low">低</option>
                        </select>
                        <select
                          value={editDraft.goalId}
                          onChange={(e) => setEditDraft((d) => ({ ...d, goalId: e.target.value }))}
                          aria-label="关联目标"
                        >
                          <option value="">无关联</option>
                          {activeGoals.map((g) => (
                            <option key={g.id} value={g.id}>
                              {goalTypeLabel[g.type]} · {g.title}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="edit-task-actions">
                        <button className="secondary-action" onClick={() => saveEditingTask(task.id)}>
                          <CheckCircle2 size={16} />
                          保存
                        </button>
                        <button className="icon-button" onClick={cancelEditingTask}>
                          <X size={17} />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              }

              return (
              <article
                className={`task-item is-draggable ${task.status === "done" ? "done" : ""}${task.kind === "fixed" ? " fixed" : ""}${task.kind !== "fixed" ? " priority-" + task.priority : ""}`}
                key={task.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", task.id);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                title="拖到右侧时间轴可安排到具体时间"
              >
                <button
                  type="button"
                  className={`check-button${task.status === "done" ? " is-done" : ""}`}
                  role="checkbox"
                  aria-checked={task.status === "done"}
                  aria-label={task.status === "done" ? "标记未完成" : "标记完成"}
                  title={task.status === "done" ? "标记未完成" : "标记完成"}
                  onClick={() => updateTask(task.id, { status: task.status === "done" ? "open" : "done" })}
                >
                  {task.status === "done" ? <CheckSquare size={20} /> : <Square size={20} />}
                </button>
                <div className="task-main">
                  <strong>{task.title}</strong>
                  <span className="task-meta">
                    {task.kind === "fixed" ? (
                      <span className="task-fixed-badge">固定</span>
                    ) : (
                      <span className={`priority-badge ${task.priority}`}>{priorityLabel[task.priority]}</span>
                    )}
                    <span>{task.estimateMinutes} 分钟</span>
                    {parentGoal && (
                      <span className="task-goal-link">
                        <Target size={12} />
                        {parentGoal.title}
                      </span>
                    )}
                  </span>
                </div>
                <button title="编辑任务" className="icon-button" onClick={() => startEditingTask(task)}>
                  <Pencil size={17} />
                </button>
                <button title="顺延到明天" className="icon-button" onClick={() => deferTask(task.id)}>
                  <SkipForward size={17} />
                </button>
                <button title="删除任务" className="icon-button danger" onClick={() => deleteTask(task.id)}>
                  <Trash2 size={17} />
                </button>
              </article>
            );
            })}
        {futureTasks.length > 0 && (
          <>
            <div className="future-divider">未来待办</div>
            {futureTasks.map((task) => (
              <article className="task-item future" key={task.id}>
                <div className="future-placeholder" />
                <div className="task-main">
                  <strong>{task.title}</strong>
                  <span className="task-meta">
                    <span className={`priority-badge ${task.priority}`}>{priorityLabel[task.priority]}</span>
                    <span>{task.estimateMinutes} 分钟</span>
                    <span className="task-goal-link">{formatShortDate(task.date)}</span>
                  </span>
                </div>
                <button title="编辑任务" className="icon-button" onClick={() => startEditingTask(task)}>
                  <Pencil size={17} />
                </button>
                <button title="安排到今天" className="icon-button solid" onClick={() => deferTaskTo(task.id, selectedDate)}>
                  <Plus size={17} />
                </button>
                <button title="删除任务" className="icon-button danger" onClick={() => deleteTask(task.id)}>
                  <Trash2 size={17} />
                </button>
              </article>
            ))}
          </>
        )}
        </div>
      </section>

      <section className="panel schedule-panel">
        <div className="section-heading">
          <div>
            <h2>时间分配</h2>
          </div>
          <button className="secondary-action" onClick={autoSchedule} disabled={aiStatus.loading || Boolean(schedulePreview)}>
            <Sparkles size={18} />
            {aiStatus.loading ? "正在生成预览" : "自动安排"}
          </button>
        </div>

        {scheduleNotice.text && (
          <div className={`schedule-notice ${scheduleNotice.tone === "error" ? "is-error" : "is-info"}`} role="status">
            <span>{scheduleNotice.text}</span>
            <button
              type="button"
              className="schedule-notice-close"
              aria-label="关闭提示"
              onClick={() => setScheduleNotice({ text: "", tone: "" })}
            >
              ×
            </button>
          </div>
        )}

        {schedulePreview && (
          <div className="schedule-preview">
            <div className="schedule-preview-head">
              <strong>排期预览（未应用）</strong>
              <span>确认后才会改动你的时间轴。</span>
            </div>
            <ul className="schedule-preview-list">
              {[...schedulePreview.blocks]
                .filter((block) => block.date === selectedDate)
                .sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
                .map((block) => {
                  const previewTask = schedulePreview.tasks.find((task) => task.id === block.taskId);
                  const name = previewTask?.title || block.title || (block.type === "busy" ? "固定占用" : "任务");
                  return (
                    <li key={block.id} className={block.type === "busy" ? "busy" : ""}>
                      <span className="preview-time">{block.start}–{block.end}</span>
                      <span className="preview-name">{name}</span>
                    </li>
                  );
                })}
            </ul>
            <div className="schedule-preview-meta">
              {schedulePreview.addedTaskCount ? `新增 ${schedulePreview.addedTaskCount} 个任务 · ` : ""}
              {schedulePreview.questions?.length ? `${schedulePreview.questions.length} 项需你判断（应用后在下方处理）` : "全部已排入"}
            </div>
            <div className="schedule-preview-actions">
              <button className="primary-action" onClick={confirmSchedulePreview}>
                <CheckCircle2 size={18} />
                确认应用
              </button>
              <button className="secondary-action" onClick={cancelSchedulePreview}>
                取消
              </button>
            </div>
          </div>
        )}

        {scheduleUndo && !schedulePreview && (
          <div className="schedule-undo">
            <span>已应用自动安排。</span>
            <button className="secondary-action" onClick={undoSchedule}>撤销自动安排</button>
          </div>
        )}

        <form className="block-form" onSubmit={addManualBlock}>
          <select
            name="type"
            value={blockDraft.type}
            onChange={(event) => setBlockDraft((draft) => ({ ...draft, type: event.target.value }))}
            aria-label="时间块类型"
          >
            <option value="task">任务时间块</option>
            <option value="busy">不可用时间</option>
          </select>
          <select
            name="taskId"
            value={blockDraft.taskId}
            onChange={(event) => setBlockDraft((draft) => ({ ...draft, taskId: event.target.value }))}
            aria-label="选择任务"
            disabled={blockDraft.type === "busy"}
          >
            <option value="">自定义时间块</option>
            {todayTasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
          <input
            name="title"
            value={blockDraft.title}
            onChange={(event) => setBlockDraft((draft) => ({ ...draft, title: event.target.value }))}
            placeholder={blockDraft.type === "busy" ? "监考、会议、通勤" : "可选标题"}
          />
          <input
            name="start"
            type="time" lang="zh-CN"
            value={blockDraft.start}
            onChange={(event) => setBlockDraft((draft) => ({ ...draft, start: event.target.value }))}
          />
          <input
            name="end"
            type="time" lang="zh-CN"
            value={blockDraft.end}
            onChange={(event) => setBlockDraft((draft) => ({ ...draft, end: event.target.value }))}
          />
          <button
            title="加入时间块"
            className="compact-action solid"
            onClick={(event) => {
              event.preventDefault();
              submitBlockForm(event.currentTarget.form);
            }}
          >
            <Plus size={18} />
            添加
          </button>
        </form>

        {scheduleQuestions.length > 0 && (
          <div className="schedule-questions">
            <div>
              <strong>需要你判断放在哪里</strong>
              <span>这些任务暂时不适合自动安排。</span>
            </div>
            {scheduleQuestions.map((question) => (
              <article className="schedule-question" key={question.id}>
                <div>
                  <strong>{question.title}</strong>
                  <span>
                    {question.estimateMinutes} 分钟 · {question.reason}
                  </span>
                </div>
                <div className="schedule-question-actions">
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={() => fillScheduleQuestion(question)}
                  >
                    今日
                  </button>
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={() => {
                      setDeferringQuestionId(question.id);
                      setDeferTargetDate(addDays(selectedDate, 1));
                    }}
                  >
                    延期
                  </button>
                </div>
                {deferringQuestionId === question.id && (
                  <div className="defer-picker" style={{ gridColumn: "1 / -1" }}>
                    <input
                      type="date"
                      value={deferTargetDate}
                      onChange={(e) => setDeferTargetDate(e.target.value)}
                    />
                    <button className="primary-action" onClick={() => {
                      deferTaskTo(question.taskId, deferTargetDate);
                      setScheduleQuestions((qs) => qs.filter((q) => q.id !== question.id));
                      setDeferringQuestionId(null);
                    }}>确认</button>
                    <button className="secondary-action" onClick={() => setDeferringQuestionId(null)}>取消</button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}

        {editingBlockId && (
          <div className="dt-editbar">
            <input type="time" lang="zh-CN" value={blockEditDraft.start}
              onChange={(e) => setBlockEditDraft((d) => ({ ...d, start: e.target.value }))} aria-label="开始时间" />
            <input type="time" lang="zh-CN" value={blockEditDraft.end}
              onChange={(e) => setBlockEditDraft((d) => ({ ...d, end: e.target.value }))} aria-label="结束时间" />
            <select value={blockEditDraft.type}
              onChange={(e) => setBlockEditDraft((d) => ({ ...d, type: e.target.value }))}>
              <option value="task">任务</option>
              <option value="busy">不可用</option>
            </select>
            <input className="dt-edit-title" value={blockEditDraft.title}
              onChange={(e) => setBlockEditDraft((d) => ({ ...d, title: e.target.value }))} placeholder="标题（可选）" />
            <button className="btn-text" onClick={() => saveEditingBlock(editingBlockId)}>保存</button>
            <button className="btn-text" onClick={cancelEditingBlock}>取消</button>
          </div>
        )}

        <DayTimeline
          blocks={todayBlocks}
          taskById={taskById}
          settings={planner.settings}
          selectedDate={selectedDate}
          onReschedule={applyDragReschedule}
          onDropTask={scheduleTaskAtMinute}
          onEdit={startEditingBlock}
          onDelete={deleteBlock}
          onToggleDone={(block) => {
            const t = taskById[block.taskId];
            if (t) updateTask(t.id, { status: t.status === "done" ? "open" : "done" });
          }}
        />
      </section>
    </div>
  );
}

function GoalsView({
  goals,
  tasks,
  selectedDate,
  goalDraft,
  setGoalDraft,
  addGoal,
  submitGoalForm,
  updateGoal,
  breakdownDraft,
  setBreakdownDraft,
  breakdownSuggestions,
  generateBreakdown,
  acceptBreakdown,
  aiStatus,
  goalById,
  deleteGoal,
}) {
  const parentOptions = goals.filter((goal) => {
    if (goalDraft.type === "long") return false;
    if (goalDraft.type === "month") return goal.type === "long";
    return goal.type === "month";
  });
  const futureTasks = tasks
    .filter((task) => task.status !== "done" && task.date !== selectedDate)
    .sort((a, b) => a.date.localeCompare(b.date) || priorityOrder[b.priority] - priorityOrder[a.priority]);

  return (
    <div className="goals-layout">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">新增目标</p>
            <h2>把大方向拆到本周</h2>
          </div>
        </div>
        <form className="goal-form" onSubmit={addGoal}>
          <input
            name="title"
            value={goalDraft.title}
            onChange={(event) => setGoalDraft((draft) => ({ ...draft, title: event.target.value }))}
            placeholder="写一个目标或结果"
          />
          <select
            name="type"
            value={goalDraft.type}
            onChange={(event) => setGoalDraft((draft) => ({ ...draft, type: event.target.value, parentId: "" }))}
          >
            <option value="long">长期</option>
            <option value="month">月度</option>
            <option value="week">本周</option>
          </select>
          <select
            name="parentId"
            value={goalDraft.parentId}
            onChange={(event) => setGoalDraft((draft) => ({ ...draft, parentId: event.target.value }))}
            disabled={goalDraft.type === "long"}
          >
            <option value="">无上级目标</option>
            {parentOptions.map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goal.title}
              </option>
            ))}
          </select>
          <select
            name="priority"
            value={goalDraft.priority}
            onChange={(event) => setGoalDraft((draft) => ({ ...draft, priority: event.target.value }))}
          >
            <option value="high">高优先级</option>
            <option value="medium">中优先级</option>
            <option value="low">低优先级</option>
          </select>
          <button
            type="submit"
            title="添加目标"
            className="compact-action solid"
            onClick={(event) => {
              event.preventDefault();
              submitGoalForm(event.currentTarget.form);
            }}
          >
            <Plus size={18} />
            添加
          </button>
        </form>
      </section>

      <section className="panel breakdown-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">拆解向导</p>
            <h2>把目标变成下一步</h2>
          </div>
        </div>
        <form className="breakdown-form" onSubmit={generateBreakdown}>
          <select
            value={breakdownDraft.goalId}
            onChange={(event) => setBreakdownDraft((draft) => ({ ...draft, goalId: event.target.value }))}
            disabled={goals.length === 0}
          >
            <option value="">{goals.length ? "选择一个目标" : "先新增一个目标"}</option>
            {goals.map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goalTypeLabel[goal.type]} · {goal.title}
              </option>
            ))}
          </select>
          <input
            value={breakdownDraft.outcome}
            onChange={(event) => setBreakdownDraft((draft) => ({ ...draft, outcome: event.target.value }))}
            placeholder="期望交付结果"
          />
          <input
            type="date"
            value={breakdownDraft.deadline}
            onChange={(event) => setBreakdownDraft((draft) => ({ ...draft, deadline: event.target.value }))}
          />
          <textarea
            value={breakdownDraft.constraints}
            onChange={(event) => setBreakdownDraft((draft) => ({ ...draft, constraints: event.target.value }))}
            placeholder="依赖、限制或风险"
          />
          <button className="primary-action" disabled={goals.length === 0}>
            <Wand2 size={18} />
            生成拆解
          </button>
        </form>

        {aiStatus.message && <div className="ai-message block">{aiStatus.message}</div>}
        {aiStatus.error && <div className="ai-error block">{aiStatus.error}</div>}

        {breakdownSuggestions.length > 0 && (
          <div className="breakdown-results">
            {breakdownSuggestions.map((item, index) => (
              <article className="breakdown-item" key={`${item.title}-${index}`}>
                <span>{item.kind === "goal" ? goalTypeLabel[item.type] : item.date}</span>
                <strong>{item.title}</strong>
                <em>{item.kind === "task" ? `${item.estimateMinutes} 分钟` : `${priorityLabel[item.priority]}优先级`}</em>
              </article>
            ))}
            <button className="secondary-action" onClick={acceptBreakdown}>
              <CheckCircle2 size={18} />
              加入计划
            </button>
          </div>
        )}
      </section>

      <section className="panel future-task-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">后续任务</p>
            <h2>今天之外的已拆解事项</h2>
          </div>
        </div>
        {futureTasks.length > 0 ? (
          <div className="future-task-list">
            {futureTasks.map((task) => {
              const linkedGoal = task.goalId ? goalById[task.goalId] : null;
              return (
                <article className="future-task-item" key={task.id}>
                  <span>{formatHumanDate(task.date)}</span>
                  <strong>{task.title}</strong>
                  <em>
                    {priorityLabel[task.priority]} · {task.estimateMinutes} 分钟
                    {linkedGoal ? ` · ${linkedGoal.title}` : ""}
                  </em>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={<ListTodo size={22} />} text="还没有今天之外的后续任务。" />
        )}
      </section>

      <GoalGantt
        goals={goals}
        tasks={tasks}
        goalById={goalById}
        updateGoal={updateGoal}
        deleteGoal={deleteGoal}
      />
    </div>
  );
}

// 两个 YYYY-MM-DD 的天数差（b - a），用 UTC 避免夏令时误差
function dayDiff(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// 甘特图数据：每个目标的时间跨度（优先取「该目标及其子目标」关联任务的日期范围，无任务则按类型从今天给默认区间），
// 按层级深度优先排成有序行，并算出整体时间轴范围（左右各留 2 天）。
function buildGoalGantt(goals, tasks, todayStr) {
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

function GoalGantt({ goals, tasks, goalById, updateGoal, deleteGoal }) {
  const [editingGoalId, setEditingGoalId] = useState(null);
  const [editDraft, setEditDraft] = useState({ title: "", type: "long", priority: "medium", parentId: "", startDate: "", endDate: "" });
  const [editError, setEditError] = useState("");
  const today = getLocalDate();

  function startEditingGoal(goal) {
    setEditingGoalId(goal.id);
    setEditDraft({ title: goal.title, type: goal.type, priority: goal.priority, parentId: goal.parentId || "", startDate: goal.startDate || "", endDate: goal.endDate || "" });
    setEditError("");
  }
  function cancelEditingGoal() {
    setEditingGoalId(null);
    setEditError("");
  }
  function saveEditingGoal(goalId) {
    if (!editDraft.title.trim()) return;
    if (editDraft.startDate && editDraft.endDate && editDraft.startDate > editDraft.endDate) {
      setEditError("结束日期不能早于开始日期");
      return;
    }
    updateGoal(goalId, {
      title: editDraft.title.trim(),
      type: editDraft.type,
      priority: editDraft.priority,
      parentId: editDraft.parentId || "",
      startDate: editDraft.startDate || "",
      endDate: editDraft.endDate || "",
    });
    setEditingGoalId(null);
    setEditError("");
  }
  function handleStatusChange(goal, status) {
    if (status === "done") updateGoal(goal.id, { status: "done", progress: 100 });
    else updateGoal(goal.id, { status });
  }
  function handleProgressChange(goal, value) {
    const progress = Number(value);
    if (progress >= 100) updateGoal(goal.id, { progress: 100, status: "done" });
    else updateGoal(goal.id, { progress });
  }

  const { rows, min, max } = useMemo(() => buildGoalGantt(goals, tasks, today), [goals, tasks, today]);
  const totalDays = Math.max(1, dayDiff(min, max));
  const pct = (date) => Math.max(0, Math.min(100, (dayDiff(min, date) / totalDays) * 100));
  const ticks = [];
  for (let d = min; d <= max; d = addDays(d, 7)) ticks.push(d);
  const showToday = today >= min && today <= max;

  if (!goals.length) {
    return (
      <section className="panel goal-gantt-panel">
        <div className="section-heading">
          <h2>目标甘特图</h2>
        </div>
        <EmptyState icon={<Target size={22} />} text="还没有目标。在上方新增长期 / 月度 / 本周目标后，这里会按时间线展示。" />
      </section>
    );
  }

  return (
    <section className="panel goal-gantt-panel">
      <div className="section-heading">
        <h2>目标甘特图</h2>
        <span className="gantt-hint">跨度按关联任务的日期范围；无任务的目标按类型给默认区间（虚线条）</span>
      </div>
      <div className="gantt">
        <div className="gantt-axis">
          <div className="gantt-axis-spacer" />
          <div className="gantt-axis-track">
            {ticks.map((d) => (
              <span key={d} className="gantt-tick" style={{ left: `${pct(d)}%` }}>
                {formatShortDate(d)}
              </span>
            ))}
            {showToday && (
              <span className="gantt-axis-today" style={{ left: `${pct(today)}%` }}>今天</span>
            )}
          </div>
        </div>
        <div className="gantt-rows">
          {rows.map(({ goal, depth, span, prog }) => {
            const progress = prog.value;
            const progressLocked = prog.auto || goal.status === "done";
            if (editingGoalId === goal.id) {
              return (
                <div className="gantt-row is-editing" key={goal.id}>
                  <div className="goal-edit-form">
                    <input
                      value={editDraft.title}
                      onChange={(e) => setEditDraft((d) => ({ ...d, title: e.target.value }))}
                      placeholder="目标标题"
                    />
                    <div className="goal-edit-row">
                      <select
                        value={editDraft.type}
                        onChange={(e) => setEditDraft((d) => ({ ...d, type: e.target.value, parentId: "" }))}
                      >
                        <option value="long">长期</option>
                        <option value="month">月度</option>
                        <option value="week">本周</option>
                      </select>
                      <select
                        value={editDraft.priority}
                        onChange={(e) => setEditDraft((d) => ({ ...d, priority: e.target.value }))}
                      >
                        <option value="high">高优先级</option>
                        <option value="medium">中优先级</option>
                        <option value="low">低优先级</option>
                      </select>
                    </div>
                    <div className="goal-edit-row">
                      <select
                        value={editDraft.parentId}
                        onChange={(e) => setEditDraft((d) => ({ ...d, parentId: e.target.value }))}
                      >
                        <option value="">无上级目标</option>
                        {goals
                          .filter((g) => (editDraft.type === "month" ? g.type === "long" : editDraft.type === "week" ? g.type === "month" : false))
                          .map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.title}
                            </option>
                          ))}
                      </select>
                    </div>
                    <div className="goal-edit-row">
                      <label>
                        开始
                        <input
                          type="date"
                          value={editDraft.startDate}
                          onChange={(e) => { setEditDraft((d) => ({ ...d, startDate: e.target.value })); setEditError(""); }}
                        />
                      </label>
                      <label>
                        结束
                        <input
                          type="date"
                          value={editDraft.endDate}
                          onChange={(e) => { setEditDraft((d) => ({ ...d, endDate: e.target.value })); setEditError(""); }}
                        />
                      </label>
                    </div>
                    {editError && <div className="goal-edit-error">{editError}</div>}
                    <div className="goal-edit-actions">
                      <button className="secondary-action" onClick={() => saveEditingGoal(goal.id)}>保存</button>
                      <button className="secondary-action" onClick={cancelEditingGoal}>取消</button>
                    </div>
                  </div>
                </div>
              );
            }
            const left = pct(span.start);
            const width = Math.max(2.5, ((dayDiff(span.start, span.end) + 1) / totalDays) * 100);
            return (
              <div className="gantt-row" key={goal.id}>
                <div className="gantt-label" style={{ paddingLeft: 10 + depth * 14 }}>
                  <div className="gantt-label-top">
                    <span className={`gantt-dot ${goal.type}`} title={goalTypeLabel[goal.type]} />
                    <strong className="gantt-title" title={goal.title}>{goal.title}</strong>
                    <button className="icon-button" title="编辑目标" onClick={() => startEditingGoal(goal)}>
                      <Pencil size={14} />
                    </button>
                    <button className="icon-button danger" title="删除目标" onClick={() => deleteGoal(goal.id)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="gantt-label-bot">
                    <select
                      className="gantt-status"
                      value={goal.status}
                      onChange={(e) => handleStatusChange(goal, e.target.value)}
                      title="状态"
                    >
                      <option value="active">进行</option>
                      <option value="paused">暂停</option>
                      <option value="done">完成</option>
                    </select>
                    <input
                      className="gantt-progress"
                      type="range"
                      min="0"
                      max="100"
                      value={progress}
                      disabled={progressLocked}
                      onChange={(e) => handleProgressChange(goal, e.target.value)}
                      title={prog.auto ? `进度由 ${prog.count} 个${prog.kind === "tasks" ? "关联任务" : "子目标"}自动汇总，不可手动调整` : "拖动调整进度"}
                    />
                    <span className={`gantt-pct${prog.auto ? " is-auto" : ""}`} title={prog.auto ? "由子项自动汇总" : ""}>{progress}%</span>
                  </div>
                </div>
                <div className="gantt-track">
                  {ticks.map((d) => (
                    <span key={d} className="gantt-grid" style={{ left: `${pct(d)}%` }} />
                  ))}
                  {showToday && <span className="gantt-track-today" style={{ left: `${pct(today)}%` }} />}
                  <div
                    className={`gantt-bar status-${goal.status} priority-${goal.priority}${span.derived === "type" ? " estimated" : ""}${span.derived === "explicit" ? " explicit" : ""}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    title={`${span.start} → ${span.end}（${span.derived === "explicit" ? "手动指定" : span.derived === "tasks" ? "按关联任务" : "按类型估算"}）`}
                  >
                    <span className="gantt-bar-fill" style={{ width: `${progress}%` }} />
                    <span className="gantt-bar-pct">{progress}%</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ReviewView({
  selectedDate,
  todayTasks,
  dayPlan,
  reviewDraft,
  setReviewDraft,
  saveReview,
  submitReviewForm,
  carryUnfinished,
  reviews,
}) {
  const unfinished = todayTasks.filter((task) => task.status !== "done");
  const dailyReview = reviews.find((review) => review.date === selectedDate && review.type === "daily");

  return (
    <div className="review-layout">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">晚间复盘</p>
            <h2>{formatHumanDate(selectedDate)}</h2>
          </div>
          {unfinished.length > 0 && (
            <button className="secondary-action" onClick={carryUnfinished}>
              <RefreshCw size={18} />
              未完成顺延
            </button>
          )}
        </div>
        <form className="review-form" onSubmit={saveReview}>
          <label>
            今天完成了什么
            <textarea
              name="completed"
              value={reviewDraft.completed}
              onChange={(event) => setReviewDraft((draft) => ({ ...draft, completed: event.target.value }))}
              placeholder="结果、产出、推进"
            />
          </label>
          <label>
            卡点
            <textarea
              name="blockers"
              value={reviewDraft.blockers}
              onChange={(event) => setReviewDraft((draft) => ({ ...draft, blockers: event.target.value }))}
              placeholder="时间、资源、状态、外部变化"
            />
          </label>
          <label>
            需要调整什么
            <textarea
              name="adjustments"
              value={reviewDraft.adjustments}
              onChange={(event) => setReviewDraft((draft) => ({ ...draft, adjustments: event.target.value }))}
              placeholder="影响本周、本月或长期计划的变化"
            />
          </label>
          <label>
            明天优先处理
            <textarea
              name="tomorrowFocus"
              value={reviewDraft.tomorrowFocus}
              onChange={(event) => setReviewDraft((draft) => ({ ...draft, tomorrowFocus: event.target.value }))}
              placeholder="留给明天的第一件事"
            />
          </label>
          <button
            type="submit"
            className="primary-action"
            onClick={(event) => {
              event.preventDefault();
              submitReviewForm(event.currentTarget.form);
            }}
          >
            <Send size={18} />
            保存复盘
          </button>
        </form>
      </section>

      <section className="panel review-summary">
        <p className="eyebrow">今日状态</p>
        <h2>{dayPlan.eveningDone || dailyReview ? "已复盘" : "等待收束"}</h2>
        <div className="summary-list">
          <span>完成任务：{todayTasks.filter((task) => task.status === "done").length}</span>
          <span>未完成：{unfinished.length}</span>
          <span>精力：{dayPlan.energy}</span>
        </div>
        {dailyReview?.adjustments && (
          <div className="adjustment-callout">
            <Moon size={18} />
            <span>{dailyReview.adjustments}</span>
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value, tone = "" }) {
  return (
    <article className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function EmptyState({ icon, text }) {
  return (
    <div className="empty-state">
      {icon}
      <span>{text}</span>
    </div>
  );
}

// 渲染崩溃兜底：避免白屏，给出可刷新的提示 —— from PR #6 (hrjtju)
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("ErrorBoundary caught:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 48, textAlign: "center" }}>
          <h2 style={{ marginBottom: 12 }}>页面出错了</h2>
          <p style={{ color: "#667085", marginBottom: 16 }}>{this.state.error.message}</p>
          <button
            className="primary-action"
            onClick={() => {
              this.setState({ error: null });
              window.location.reload();
            }}
          >
            刷新页面
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default App;
