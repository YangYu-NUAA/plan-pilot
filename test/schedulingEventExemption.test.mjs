import test from "node:test";
import assert from "node:assert/strict";
import { buildAutoBlocks, reconcileScheduleBlocks, freeDayGaps } from "../src/planner/scheduling.js";
import { isEventLikeTodo } from "../src/planningSemantics.js";

const SETTINGS = {
  workSegments: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "18:00" }],
  shortBreak: 10,
  longBreak: 30,
};

const task = (id, title, extra = {}) => ({
  id,
  title,
  date: "2026-08-27",
  status: "open",
  estimateMinutes: 60,
  priority: "medium",
  ...extra,
});

// 让工作时段被一条巨大 busy 块完全占满，浮动任务只能靠豁免才能排在时段外。
function fullyBusySettings() {
  return {
    blocks: [
      { id: "b-busy", type: "busy", date: "2026-08-27", title: "全天外出评审", start: "09:00", end: "18:00", auto: false },
    ],
    tasks: [task("t-dinner", "晚上和老同学聚餐")],
  };
}

test("isEventLikeTodo：事件语义真值表", () => {
  assert.equal(isEventLikeTodo("晚上和老同学聚餐"), true);
  assert.equal(isEventLikeTodo("去医院体检"), true);
  assert.equal(isEventLikeTodo("下午组会"), true);
  assert.equal(isEventLikeTodo("去银行办理签证"), true);
  // 非事件类
  assert.equal(isEventLikeTodo("写开题报告初稿"), false);
  assert.equal(isEventLikeTodo(""), false);
  // 特殊流不豁免
  assert.equal(isEventLikeTodo("买明天的高铁票"), false); // 购票确认流
  assert.equal(isEventLikeTodo("整理会议纪要行动项"), false); // 会后整理需锚定会议
});

test("freeDayGaps：全日占用反向求隙", () => {
  const gaps = freeDayGaps(0, 1440, [
    { start: "09:00", end: "12:00" },
    { start: "13:00", end: "18:00" },
  ]);
  assert.deepEqual(gaps.map((g) => [g.start, g.end]), [[0, 540], [720, 780], [1080, 1440]]);
  // 越界裁剪：部分重叠的占用块被夹进边界内
  const clipped = freeDayGaps(540, 720, [{ start: "09:30", end: "11:00" }]);
  assert.deepEqual(clipped.map((g) => [g.start, g.end]), [[540, 570], [660, 720]]);
  // 完全被占用 → 无空档
  assert.deepEqual(freeDayGaps(600, 700, [{ start: "08:00", end: "12:00" }]), []);
  assert.deepEqual(freeDayGaps(600, 500, []), []);
});

test("buildAutoBlocks：工作时段被占满时，事件类待办豁免到时段外的晚间空档", () => {
  const { blocks, questions } = buildAutoBlocks({
    tasks: [task("t-dinner", "晚上和老同学聚餐")],
    existingBlocks: [{ id: "b-busy", type: "busy", date: "2026-08-27", title: "全天外出评审", start: "09:00", end: "18:00", auto: false }],
    settings: SETTINGS,
    selectedDate: "2026-08-27",
  });
  const dinner = blocks.find((b) => b.taskId === "t-dinner");
  assert.ok(dinner, "聚餐应获得时间块");
  assert.equal(dinner.start, "18:00"); // 全天忙 → 第一个空档是 18 点起
  assert.equal(dinner.end, "19:00");
  assert.equal(dinner.outsideWindow, true);
  assert.ok(!questions.some((q) => q.taskId === "t-dinner"), "不应再成为待决问题");
});

test("buildAutoBlocks：同样条件下普通任务不被豁免（回归守卫）", () => {
  const { blocks, questions } = buildAutoBlocks({
    tasks: [task("t-report", "写季度总结报告")],
    existingBlocks: [{ id: "b-busy", type: "busy", date: "2026-08-27", title: "全天外出评审", start: "09:00", end: "18:00", auto: false }],
    settings: SETTINGS,
    selectedDate: "2026-08-27",
  });
  assert.ok(!blocks.some((b) => b.taskId === "t-report"));
  const q = questions.find((x) => x.taskId === "t-report");
  assert.ok(q, "普通任务应进入待决问题而非排出时段外块");
});

test("buildAutoBlocks：优先在工作时段内正常排，只有放不下才豁免到外", () => {
  const { blocks } = buildAutoBlocks({
    tasks: [task("t-dinner", "晚上和老同学聚餐")],
    existingBlocks: [],
    settings: SETTINGS,
    selectedDate: "2026-08-27",
  });
  const dinner = blocks.find((b) => b.taskId === "t-dinner");
  assert.ok(dinner);
  assert.equal(dinner.start, "09:00"); // 工作时段有空间 → 照旧在段内排（行为不变）
  assert.ok(!dinner.outsideWindow);
});

test("reconcileScheduleBlocks：带 outsideWindow 标记的块在时段外存活；无标记的被清理", () => {
  const flagged = { id: "b-e1", type: "task", taskId: "t1", date: "2026-08-27", title: "晚上聚餐", start: "19:00", end: "20:00", auto: true, outsideWindow: true };
  const unflagged = { id: "b-e2", type: "task", taskId: "t2", date: "2026-08-27", title: "晚间阅读", start: "21:00", end: "22:00", auto: true };
  const result = reconcileScheduleBlocks([flagged, unflagged], SETTINGS, "2026-08-27");
  assert.ok(result.blocks.some((b) => b.id === "b-e1"), "豁免块应保留");
  assert.ok(!result.blocks.some((b) => b.id === "b-e2"), "普通时段外块应被移除");
  assert.deepEqual(result.removedTaskIds.sort(), ["t2"]);
});

test("reconcileScheduleBlocks：豁免块仍禁止与忙块重叠", () => {
  const eveningBusy = { id: "b-show", type: "busy", date: "2026-08-27", title: "看演出", start: "19:30", end: "22:00", auto: false };
  const flagged = { id: "b-e1", type: "task", taskId: "t1", date: "2026-08-27", title: "晚上聚餐", start: "19:00", end: "20:00", auto: true, outsideWindow: true };
  const result = reconcileScheduleBlocks([eveningBusy, flagged], SETTINGS, "2026-08-27");
  assert.ok(!result.blocks.some((b) => b.id === "b-e1"), "与晚间忙块重叠 → 即便是豁免块也清除");
});

test("buildAutoBlocks：notBefore 不早于当前时间的约束对豁免同样生效", () => {
  const { blocks, questions } = buildAutoBlocks({
    tasks: [task("t-coffee", "和朋友下午茶"),
      (() => { const t = task("t-late", "深夜赶航班前往机场"); t.estimateMinutes = 60; return t; })()],
    existingBlocks: [],
    settings: { ...SETTINGS },
    selectedDate: "2026-08-27",
    notBefore: 20 * 60, // 当前已 20:00
  });
  for (const id of ["t-coffee", "t-late"]) {
    const block = blocks.find((b) => b.taskId === id);
    if (!block) continue;
    const [hh, mm] = block.start.split(":").map(Number);
    const minutes = hh * 60 + mm;
    assert.ok(minutes >= 20 * 60, `${id} 起点 ${block.start} 不得早于 20:00`);
  }
  // 下午茶若因 notBefore 无处安放则回到待决问题（不再硬排凌晨/过去）
  const coffeeBlock = blocks.find((b) => b.taskId === "t-coffee");
  if (!coffeeBlock) {
    assert.ok(questions.some((q) => q.taskId === "t-coffee"), "无法放置时应进入待决问题");
  }
});

import { normalizeAiScheduleResult } from "../src/planner/scheduling.js";

test("normalizeAiScheduleResult：事件类任务的时段外 AI 建议被接受并打豁免标记", () => {
  const tasks = [task("t-dinner", "晚上和老同学聚餐")];
  const busy = [{ id: "b-busy", type: "busy", date: "2026-08-27", title: "全天外出评审", start: "09:00", end: "18:00", auto: false }];
  const result = normalizeAiScheduleResult(
    { blocks: [{ taskId: "t-dinner", start: "19:30", end: "20:30" }], questions: [] },
    { tasks, existingBlocks: busy, settings: SETTINGS, selectedDate: "2026-08-27" },
  );
  const dinner = result.blocks.find((b) => b.taskId === "t-dinner");
  assert.ok(dinner, "时段外的有效事件建议应被保留");
  assert.equal(dinner.start, "19:30");
  assert.equal(dinner.outsideWindow, true);
});

test("normalizeAiScheduleResult：普通任务的时段外建议仍被拒绝（回归守卫）", () => {
  const tasks = [task("t-report", "写季度总结报告")];
  const result = normalizeAiScheduleResult(
    { blocks: [{ taskId: "t-report", start: "19:30", end: "20:30" }], questions: [] },
    {
      tasks,
      existingBlocks: [{ id: "b-busy", type: "busy", date: "2026-08-27", title: "全天外出评审", start: "09:00", end: "18:00", auto: false }],
      settings: SETTINGS,
      selectedDate: "2026-08-27",
    },
  );
  assert.ok(!result.blocks.some((b) => b.taskId === "t-report"), "非事件建议不得落在工作时段之外");
  assert.ok(result.questions.some((q) => q.taskId === "t-report"), "拒绝后应进入待决问题");
});

import { polishAiBlocks } from "../src/planner/scheduling.js";

test("polishAiBlocks：豁免块在钳制管线中原样保留；普通时段外块仍被裁掉", () => {
  const exempt = { id: "b-e", type: "task", taskId: "t1", title: "晚上聚餐", start: "19:00", end: "20:00", auto: true, outsideWindow: true };
  const ordinary = { id: "b-o", type: "task", taskId: "t2", title: "晚间阅读", start: "19:00", end: "20:00", auto: true };
  // App 集成层会过滤 _drop 标记；此处保持同一口径
  const out = polishAiBlocks([exempt, ordinary], SETTINGS.workSegments).filter((b) => !b._drop);
  assert.ok(out.some((b) => b.id === "b-e" && b.start === "19:00" && b.end === "20:00"), "豁免块不变形");
  assert.ok(!out.some((b) => b.id === "b-o"), "普通时段外块被标删并过滤");
});
