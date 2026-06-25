// 规划访谈（Coach）harness 纯函数：动作解析、消息提取、跨轮草稿合并 / 去重。
// 全部无副作用，便于在 node:test 里单测（见 test/coachHarness.test.mjs）。
// 注：区域 agenda 种子、收尾意图、自校验谓词属后续步骤 4/5，见 docs/COACH_HARNESS_DESIGN.md，未实现前不在此堆放未用代码。

// 归一化标题用于去重：小写 + 去标点 / 空白。比 App 里模糊的 titleLooksDuplicate 更严格（精确相等），
// 避免把「时序」相关的多个不同课题误并成一个。
export function normalizeKey(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[\s，。！？、,.!?;；:："'""''（）()[\]【】《》<>·\-—_]/g, "")
    .trim();
}

export function emptyDraft() {
  return { goals: [], tasks: [], busy: [] };
}

// 把模型返回的一个 action 映射成 coach item 形态（交给 normalizeCoachItems 进一步规整）。
// add_goal/add_task/add_busy → 对应 kind；ask/done/未知 → null（不是条目）。
// parentRef / goalRef 可能是已有目标 id 或某个 tempId，落库时由 resolveGoalReference 统一解析。
export function actionToItem(action) {
  if (!action || typeof action !== "object") return null;
  if (action.type === "add_goal") {
    return {
      kind: "goal",
      type: ["long", "month", "week"].includes(action.goalType) ? action.goalType : action.type2 || "",
      title: action.title,
      priority: action.priority,
      parentId: action.parentRef || action.parentId || "",
      parentTitle: action.parentTitle || "",
      tempId: action.tempId || action.id || "",
    };
  }
  if (action.type === "add_task") {
    return {
      kind: "task",
      title: action.title,
      date: action.date,
      estimateMinutes: action.estimateMinutes,
      priority: action.priority,
      goalId: action.goalRef || action.goalId || "",
      goalTitle: action.goalTitle || "",
      tempId: action.tempId || action.id || "",
    };
  }
  if (action.type === "add_busy") {
    return { kind: "busy", title: action.title, date: action.date, start: action.start, end: action.end };
  }
  return null;
}

// 取本轮要展示给用户的话：优先 message，其次 ask 动作的 question。
export function coachMessageFrom(result) {
  if (result && typeof result.message === "string" && result.message.trim()) return result.message.trim();
  const actions = Array.isArray(result?.actions) ? result.actions : [];
  const ask = actions.find((a) => a && a.type === "ask" && String(a.question || "").trim());
  return ask ? String(ask.question).trim() : "";
}

function draftKey(item) {
  if (item.kind === "goal") return `goal|${item.type || ""}|${normalizeKey(item.title)}`;
  if (item.kind === "busy") return `busy|${item.date || ""}|${normalizeKey(item.title)}`;
  return `task|${item.date || ""}|${normalizeKey(item.title)}`;
}

// 把一批新条目（已 normalize 的 coach items）并入草稿，按 draftKey 精确去重（草稿内 + 同批内）。
// 返回新草稿（不可变更原对象）。空标题项忽略。
export function mergeCoachDraft(draft, items) {
  const base = draft && draft.goals ? draft : emptyDraft();
  const next = { goals: base.goals.slice(), tasks: base.tasks.slice(), busy: base.busy.slice() };
  const seen = new Set([...next.goals, ...next.tasks, ...next.busy].map(draftKey));
  (Array.isArray(items) ? items : []).forEach((item) => {
    if (!item || !String(item.title || "").trim()) return;
    const key = draftKey(item);
    if (seen.has(key)) return;
    seen.add(key);
    if (item.kind === "goal") next.goals.push(item);
    else if (item.kind === "busy") next.busy.push(item);
    else next.tasks.push(item);
  });
  return next;
}
