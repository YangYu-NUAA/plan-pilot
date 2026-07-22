import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  ChevronRight,
  Clock3,
  ListChecks,
  Settings,
  Target,
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
  looksLikeSingleActionItem,
} from "./planningSemantics.js";
import { callPlanningAi } from "./ai/callPlanningAi.js";
import { emptyDraft, mergeCoachDraft, coachMessageFrom } from "./coachHarness.js";
import { APP_NAME } from "./constants/appConstants.js";
import { getAiProviderPreset } from "./constants/aiProviders.js";
import { defaultState } from "./app/initialState.js";
import { replaceRecurringBlocks } from "./planner/hydration.js";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { useLocalAiKey } from "./hooks/useLocalAiKey.js";
import { hydratePlannerState, usePlannerStore } from "./hooks/usePlannerStore.js";
import { uid } from "./utils/ids.js";
import {
  addDays,
  duration,
  formatHumanDate,
  formatShortDate,
  getLocalDate,
  toMinutes,
  toTime,
} from "./utils/dateTime.js";
import { priorityOrder } from "./constants/labels.js";
import { sum, fieldValue } from "./utils/form.js";
import {
  titleLooksDuplicate,
  titlesReferToSameTask,
  compactPlannerTasks,
  normalizeTitle,
  taskIdentity,
  goalIdentity,
  mergeDuplicateTasks,
  overlapsAny,
} from "./planner/dedup.js";
import {
  defaultBusyDuration,
  parseTimeInSentence,
  roughTimeWindow,
  cleanEventTitle,
  extractBusyBlocksFromText,
  recoverBusyBlocksFromPlanningContext,
  mergeUniqueBusyBlocks,
  extractActionTasksFromText,
  estimateMinutesForTitle,
  inferDateFromText,
} from "./planner/textExtract.js";
import {
  sortBlocks,
  assignTimelineColumns,
  getProtectedBreaks,
  polishAiBlocks,
  workloadMinutes,
  isInsideWorkWindow,
  normalizeAiScheduleResult,
  preparePlannerForScheduling,
  buildAutoBlocks,
} from "./planner/scheduling.js";
import {
  makeBreakdown,
  normalizeBreakdownItems,
  normalizeTaskSuggestions,
  collectCoachItems,
  normalizeCoachItems,
  attachKnownGoalReferences,
  filterCoachItems,
  filterBreakdownItems,
  filterTaskSuggestions,
} from "./planner/coachItems.js";
import { TodayView } from "./views/TodayView.jsx";
import { GoalsView } from "./views/GoalsView.jsx";
import { ReviewView } from "./views/ReviewView.jsx";
import { SettingsDrawer } from "./components/SettingsDrawer.jsx";
import { BrandMark } from "./components/ui/BrandMark.jsx";


function App() {
  const [planner, setPlanner] = usePlannerStore({
    compactPlannerTasks,
    mergeTasks: mergeDuplicateTasks,
  });
  const autoSchedulingRef = useRef(false); // 防自动安排并发（每实例，替代模块全局）—— from PR #6 (hrjtju)
  const [localAiKey, updateLocalAiKey] = useLocalAiKey();
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
    draft: emptyDraft(), // 跨轮累积的计划草稿（喂给模型作 draftSummary 去重提示；step 4 起驱动 UI）
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

  useEffect(() => {
    setScheduleQuestions([]);
    setTodayGuideActive(false);
    setSchedulePreview(null);
    setScheduleUndo(null);
    setScheduleNotice({ text: "", tone: "" });
  }, [selectedDate]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // PWA / 浏览器 UI 的主题色跟随当前主题
    const themeColors = { warm: "#f3f1ea", cool: "#e5edf8", graphite: "#e9ebf0", night: "#161311" };
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColors[theme] || themeColors.warm);
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

  // 休息时段冲突的提示文案：按当前设置（显式休息时段或工作时段间隙）动态生成
  function breakConflictNotice() {
    const label = getProtectedBreaks(planner.settings)
      .map((b) => `${b.start}-${b.end}`)
      .join("、");
    return { text: `和休息时段${label ? `（${label}）` : ""}冲突，请换一个时间。`, tone: "error" };
  }

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
    // 收集落到「非当前查看日」的日期，让保存提示能告诉用户去哪天查看（未来固定安排不在今天的时间轴上）。
    const futureDates = Array.from(
      new Set(recoveredBusy.concat(newTasks).map((x) => x.date).filter((d) => d && d !== selectedDate))
    ).sort();
    return { tasks: tasksAfter, blocks: blocksAfter, addedTaskCount: newTasks.length, addedBlockCount: blocksAfter.length - baseBlocks.length, futureDates };
  }

  function commitFixedPlanFromDayPlan() {
    const r = computeFixedPlanCommit(planner.tasks, planner.blocks);
    if (r.addedTaskCount || r.addedBlockCount) patchPlanner({ tasks: r.tasks, blocks: r.blocks });
    return r;
  }

  function saveMorningPlan() {
    const { addedTaskCount, addedBlockCount, futureDates } = commitFixedPlanFromDayPlan();
    const mdLabel = (d) => {
      const [, m, dd] = String(d).split("-");
      return `${Number(m)}月${Number(dd)}日`;
    };
    const futureNote =
      futureDates && futureDates.length
        ? ` 其中有安排落在 ${futureDates.map(mdLabel).join("、")}——不在今天的时间轴上，切到那天查看。`
        : "";
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
      }${futureNote}`,
    });
  }

  function extractFixedTasksFromText(text, date, existing) {
    const existingKeys = new Set(existing.map(taskIdentity));
    return String(text || "")
      .split(/[\n。；;]/)
      .map(normalizeSentence)
      // 带时间的承诺由 busy 块表示（占用时间轴），不再重复生成一个 kind:fixed 任务；只有无时间的承诺才落任务。
      // 排除带模糊时段（上午/下午…）的句子：那些已由 busy 块以时间窗承接，避免重复落一个无时间任务
      .filter((s) => s && isBusySentence(s) && !isMeetingSentence(s) && !parseTimeInSentence(s) && !roughTimeWindow(s) && looksLikeSingleActionItem(s))
      .map((s) => {
        const start = parseTimeInSentence(s);
        return {
          id: uid("task"),
          title: cleanEventTitle(s),
          estimateMinutes: start ? defaultBusyDuration(s) : 30,
          priority: "medium",
          goalId: "",
          // 按句子里的日期路由（"27号/明天/6月27日"→ 对应那天），无日期则落到当前查看日。
          date: inferDateFromText(s, date),
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

  // 一键填入示例数据：给新用户一个「有内容的一天」来体验时间轴、任务与目标联动
  function loadSampleData() {
    const now = new Date().toISOString();
    const longGoal = {
      id: uid("goal"), title: "完成项目申请书并提交（示例）", type: "long", parentId: "",
      priority: "high", startDate: "", endDate: "", status: "active", progress: 0, createdAt: now,
    };
    const weekGoal = {
      id: uid("goal"), title: "写出申请书初稿框架（示例）", type: "week", parentId: longGoal.id,
      priority: "high", startDate: "", endDate: "", status: "active", progress: 0, createdAt: now,
    };
    const task1 = {
      id: uid("task"), title: "写申请书「研究背景」小节（示例）", estimateMinutes: 60, priority: "high",
      goalId: weekGoal.id, date: selectedDate, status: "open", createdAt: now,
    };
    const task2 = {
      id: uid("task"), title: "整理上次组会反馈并更新大纲（示例）", estimateMinutes: 30, priority: "medium",
      goalId: weekGoal.id, date: selectedDate, status: "open", createdAt: now,
    };
    const task3 = {
      id: uid("task"), title: "回复合作者邮件（示例）", estimateMinutes: 15, priority: "low",
      goalId: "", date: selectedDate, status: "open", createdAt: now,
    };
    const blocks = [
      { id: uid("block"), taskId: "", title: "组会（示例）", type: "busy", date: selectedDate, start: "10:00", end: "11:00", auto: false },
      { id: uid("block"), taskId: task1.id, title: task1.title, type: "task", date: selectedDate, start: "09:00", end: "10:00", auto: true },
    ];
    patchPlanner((current) => ({
      goals: current.goals.concat([longGoal, weekGoal]),
      tasks: current.tasks.concat([task1, task2, task3]),
      blocks: current.blocks.concat(blocks),
    }));
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
        apiKey: localAiKey,
        serverKeyOk: serverAiKeyLoaded,
        maxTokens: 2000,
        messages: [
          {
            role: "system",
            content:
              `You are a proactive daily time-blocking planner. Return only JSON: {\"message\":\"short scheduling note\",\"taskAdjustments\":[{\"taskId\":\"existing task id\",\"estimateMinutes\":120,\"reason\":\"why the estimate changed\"}],\"blocks\":[{\"taskId\":\"existing task id\",\"start\":\"HH:MM\",\"end\":\"HH:MM\",\"title\":\"optional\"}],\"questions\":[{\"taskId\":\"optional\",\"title\":\"...\",\"reason\":\"why uncertain\",\"hint\":\"what user should decide\"}]}.\n\n<<< HARD BOUNDARY RULE — VIOLATION IS UNACCEPTABLE >>>\nWork segments = [${segList}]. You MUST schedule EVERY block strictly within these time windows. A block starting before the first segment, ending after the last segment, or crossing into a protected break is a FATAL ERROR. Protected breaks (MUST NOT overlap any block): ${breakDesc}. Before outputting JSON, scan every block and verify: (1) start >= the segment's start, (2) end <= the segment's end, (3) the block does not intersect any protected break. If a task cannot fit, ask a question instead of violating the boundary.\n<<< END HARD BOUNDARY RULE >>>\n\nUse only existing task ids and never invent tasks. Re-plan the day from scratch on every call while respecting manual/fixed blocks and the already-pinned fixedTimeTasks as hard constraints: never output blocks for fixedTimeTasks and never overlap their time ranges; schedule the remaining tasks around them. Do not merely place tasks in input order: reason about urgency, cognitive load, context switching, dependencies, deadlines, energy, and realistic duration. Put deep research/design/writing work into coherent focus blocks, light admin work into lower-energy windows, and preserve dependencies: print before scan/upload/submit, scan before upload, outline/framework/core points before drafting, meeting preparation before the meeting, and meeting follow-up after the meeting. If a ticket-buying task does not say when the purchase itself must happen, ask the user instead of confusing the departure time with purchase time. If duration or placement is genuinely uncertain, ask one concise question instead of forcing a block. Time-splitting guidance: when multiple tasks in the same priority tier compete for limited time in one segment, split the available contiguous time among them proportionally by estimateMinutes rather than stacking arbitrarily. If a large task (≥120 min) cannot fit in a single free interval, consider splitting it across two sessions (e.g. morning + afternoon). Prefer high-focus deep work in the longest uninterrupted slots; put light admin tasks into shorter gaps. The currentAutoBlocks in the payload show what was previously auto-scheduled — you may keep, adjust, or replace them, but always explain significant changes in the message. If there are simply no tasks to place today, just return empty blocks with a brief note — do NOT generate questions asking the user to add todos.`,
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
      setScheduleNotice(breakConflictNotice());
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
      setScheduleNotice(breakConflictNotice());
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
        apiKey: localAiKey,
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
        apiKey: localAiKey,
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
        apiKey: localAiKey,
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
              // 草稿摘要：告诉模型至今已落了哪些条目，避免重复 add（harness 跨轮草稿）
              draftSummary: {
                goals: planningCoach.draft.goals.map((g) => ({ tempId: g.tempId, type: g.type, title: g.title })),
                tasks: planningCoach.draft.tasks.map((t) => ({ title: t.title, date: t.date })),
                busy: planningCoach.draft.busy.map((b) => ({ title: b.title, date: b.date })),
              },
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
        messages: nextMessages.concat({ role: "assistant", content: coachMessageFrom(result) || "我已经整理出一组建议。" }),
        suggestions: items,
        draft: mergeCoachDraft(coach.draft, items), // 把本轮 items 并入跨轮草稿
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
    setPlanner(hydratePlannerState(defaultState, mergeDuplicateTasks));
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
        setPlanner(hydratePlannerState(JSON.parse(String(reader.result || "{}")), mergeDuplicateTasks));
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
        apiKey: localAiKey,
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
          <BrandMark size={20} />
        </span>
        <nav className="rail-nav">
          <button className={activeView === "today" ? "active" : ""} data-tip="今日" aria-label="今日" onClick={() => setActiveView("today")}>
            <CalendarDays size={20} />
          </button>
          <button className={activeView === "goals" ? "active" : ""} data-tip="目标" aria-label="目标" onClick={() => setActiveView("goals")}>
            <Target size={20} />
          </button>
          <button className={activeView === "review" ? "active" : ""} data-tip="复盘" aria-label="复盘" onClick={() => setActiveView("review")}>
            <ListChecks size={20} />
          </button>
        </nav>
        <button
          className={`rail-settings ${settingsOpen ? "active" : ""}`}
          data-tip="设置"
          aria-label="设置"
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <Settings size={20} />
        </button>
      </aside>

      <SettingsDrawer
        planner={planner}
        patchPlanner={patchPlanner}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        theme={theme}
        setTheme={setTheme}
        segmentDraft={segmentDraft}
        setSegmentDraft={setSegmentDraft}
        showSegmentModal={showSegmentModal}
        setShowSegmentModal={setShowSegmentModal}
        recurringDraft={recurringDraft}
        setRecurringDraft={setRecurringDraft}
        showRecurringModal={showRecurringModal}
        setShowRecurringModal={setShowRecurringModal}
        editingRecurringId={editingRecurringId}
        setEditingRecurringId={setEditingRecurringId}
        quickRecurringTitle={quickRecurringTitle}
        setQuickRecurringTitle={setQuickRecurringTitle}
        deleteRecurring={deleteRecurring}
        updateAiSettings={updateAiSettings}
        applyAiProviderPreset={applyAiProviderPreset}
        localAiKey={localAiKey}
        updateLocalAiKey={updateLocalAiKey}
        serverAiKeyLoaded={serverAiKeyLoaded}
        aiKeyLoaded={aiKeyLoaded}
        currentAiPreset={currentAiPreset}
        exportData={exportData}
        importData={importData}
        resetLocalData={resetLocalData}
      />

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{activeView === "today" ? "今日引导" : activeView === "goals" ? "目标层级" : "收束调整"}</p>
            <h1>{viewHeadline}</h1>
            {activeView === "today" && (
              <div className="topbar-highlights">
                {upcomingHighlights.busy && (
                  <button
                    type="button"
                    className="topbar-highlight busy"
                    title={`${upcomingHighlights.busy.title} — 点击跳到 ${formatShortDate(upcomingHighlights.busy.date)}`}
                    onClick={() => setSelectedDate(upcomingHighlights.busy.date)}
                  >
                    <Clock3 size={12} />
                    {upcomingHighlights.busy.title.length > 12
                      ? upcomingHighlights.busy.title.slice(0, 12) + "..."
                      : upcomingHighlights.busy.title}
                    {" "}{formatShortDate(upcomingHighlights.busy.date)}
                  </button>
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
            {selectedDate !== getLocalDate() && (
              <button className="back-to-today" title="回到今天" onClick={() => setSelectedDate(getLocalDate())}>
                回今日
              </button>
            )}
          </div>
        </header>

        <ErrorBoundary>
        {/* key=activeView 让切换视图时容器重挂载，从而触发 .view-enter 入场动画 */}
        <div key={activeView} className="view-enter">
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
            loadSampleData={loadSampleData}
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
        </div>
        </ErrorBoundary>
      </section>
    </main>
  );
}

export default App;
