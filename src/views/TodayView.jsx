import { useState, useMemo, useEffect, useRef } from "react";
import { CalendarClock, CalendarDays, CheckCircle2, CheckSquare, Clock3, Maximize2, Pencil, Play, Plus, Rows3, SkipForward, Send, Sparkles, Square, Target, Trash2, X } from "lucide-react";
import { addDays, formatHumanDate, formatShortDate, getLocalDate, toMinutes } from "../utils/dateTime.js";
import { playTick } from "../utils/soundFx.js";
import { tapDone } from "../utils/hapticsFx.js";
import { priorityOrder, priorityLabel, goalTypeLabel, energyOptions, energyColor } from "../constants/labels.js";
import { parseTimeInSentence } from "../planner/textExtract.js";
import { findSlotForTask } from "../planner/scheduling.js";
import { isTicketPurchaseTask } from "../planningSemantics.js";
import { emptyDraft } from "../coachHarness.js";
import { EmptyState } from "../components/EmptyState.jsx";
import { OmniBar } from "../components/OmniBar.jsx";
import { useFlip } from "../hooks/useFlip.js";
import { DayTimeline } from "../components/timeline/DayTimeline.jsx";
import { Metric, MetricRing } from "../components/ui/Metric.jsx";
import { PipWindow } from "../components/PipWindow.jsx";
import { GreetingCard } from "../components/GreetingCard.jsx";

export function TodayView({
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
  sendPlanningCoachText,
  forwardToCoach,
  onExecCommand,
  acceptPlanningCoachSuggestions,
  showAiFollowUp,
  todayAiReply,
  setTodayAiReply,
  sendTodayAiReply,
  loadSampleData,
  onStartFocus,
  ai,
  localAiKey,
  voiceKey,
  serverAiKeyLoaded,
}) {
  const overload = plannedMinutes > workMinutes;
  const futureTasks = useMemo(() =>
    planner.tasks
      .filter((t) => t.date > selectedDate && t.status !== "done")
      .sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority])
      .slice(0, 2),
    [planner.tasks, selectedDate],
  );
  // 任务列表收起/展开：默认只露前几条，整页长度塌缩；状态存本地
  const [tasksExpanded, setTasksExpanded] = useState(() => {
    try { return localStorage.getItem("plan-pilot-tasks-expanded") === "1"; } catch { return false; }
  });
  const TASKS_COLLAPSED_COUNT = 4;
  const OVERDUE_COLLAPSED_COUNT = 2; // 逾期区默认只露 2 条（避免一堆逾期把列表撑爆）
  const sortedTodayTasks = useMemo(
    () => [...todayTasks].sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority]),
    [todayTasks],
  );
  const visibleTodayTasks = tasksExpanded ? sortedTodayTasks : sortedTodayTasks.slice(0, TASKS_COLLAPSED_COUNT);
  function toggleTasksExpanded() {
    setTasksExpanded((cur) => {
      const next = !cur;
      try { localStorage.setItem("plan-pilot-tasks-expanded", next ? "1" : "0"); } catch (e) { /* ignore */ }
      return next;
    });
  }
  // 逾期未完成：早于当前日期、仍未完成的任务（否则它们会从「今日」视图里彻底消失、被遗忘）
  // 逾期相对【真正的今天】，且只在查看真正今天时才列——手动翻到明天/别的日期只是浏览，不该把今天的任务标成逾期。
  // 真正的换天由系统午夜自动滚动（见 App 里的跨天定时器）触发，那时才算逾期。
  const overdueTasks = useMemo(() => {
    const realToday = getLocalDate();
    if (selectedDate !== realToday) return [];
    return planner.tasks
      .filter((t) => t.date < realToday && t.status !== "done")
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : priorityOrder[b.priority] - priorityOrder[a.priority]));
  }, [planner.tasks, selectedDate]);
  const visibleOverdueTasks = tasksExpanded ? overdueTasks : overdueTasks.slice(0, OVERDUE_COLLAPSED_COUNT);
  const [deferringTaskId, setDeferringTaskId] = useState(null);
  const chatScrollRef = useRef(null);

  // 访谈消息更新 / AI 输入中时，聊天区自动滚到底部
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [planningCoach.messages.length, planningCoach.loading]);
  const [deferTaskDate, setDeferTaskDate] = useState("");
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [editDraft, setEditDraft] = useState({ title: "", estimateMinutes: 60, priority: "medium", goalId: "" });
  const [editingBlockId, setEditingBlockId] = useState(null);
  const [deferringQuestionId, setDeferringQuestionId] = useState(null);
  const [deferTargetDate, setDeferTargetDate] = useState("");
  const [blockEditDraft, setBlockEditDraft] = useState({ title: "", start: "09:00", end: "10:00", type: "task" });
  const [dragTaskId, setDragTaskId] = useState(null); // 正在拖向时间轴的任务（幽灵块预览用）
  // 时间轴密度：fitAll=适配全天（动态缩放一屏放下），默认标准 56px/h；本地记忆
  const [fitAll, setFitAllState] = useState(() => {
    try { return localStorage.getItem("plan-pilot-timeline-fit") === "1"; } catch { return false; }
  });
  function setFitAll(updater) {
    setFitAllState((cur) => {
      const next = typeof updater === "function" ? updater(cur) : updater;
      try { localStorage.setItem("plan-pilot-timeline-fit", next ? "1" : "0"); } catch (e) { /* ignore */ }
      return next;
    });
  }
  const [timelineZoom, setTimelineZoom] = useState(false); // 全屏时间轴
  useEffect(() => {
    if (!timelineZoom) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setTimelineZoom(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [timelineZoom]);
  const taskListRef = useRef(null);
  useFlip(taskListRef, [planner.tasks]); // 任务增删 / 改优先级 / 顺延时的 FLIP 平滑重排
  const [coachFlash, setCoachFlash] = useState(false); // OmniBar 转发后访谈面板高亮闪烁
  // 晨间问题默认收起为摘要行（AI 晨间引导是主推路径），手填展开状态存本地
  const [coachExpanded, setCoachExpanded] = useState(() => {
    try { return localStorage.getItem("plan-pilot-coach-expanded") === "1"; } catch { return false; }
  });
  // 对话区默认隐藏：输入/语音/点「开始访谈」才展开；点 × 或「加入计划」后收回原样
  const [conversationOpen, setConversationOpen] = useState(false);
  // 移动端分页：规划（中枢+统计+任务）/ 时间表（独占全屏时间轴）；桌面端始终同屏
  const [mobileTab, setMobileTab] = useState("plan");
  const conversationActive =
    planningCoach.messages.length > 0 || planningCoach.loading || planningCoach.suggestions.length > 0 || conversationOpen;

  function changeCoachScope(value) {
    setPlanningCoach((coach) => ({
      ...coach,
      scope: value,
      messages: [],
      suggestions: [],
      draft: emptyDraft(),
      error: "",
    }));
  }

  function closeCoachConversation() {
    setPlanningCoach((coach) => ({ ...coach, messages: [], suggestions: [], draft: emptyDraft(), error: "", input: "" }));
    setConversationOpen(false);
  }

  function handleStartInterview() {
    setConversationOpen(true);
    startPlanningCoach();
  }

  function handleAcceptSuggestions() {
    acceptPlanningCoachSuggestions();
    closeCoachConversation();
  }

  // 手动表单降级为「高级模式」：默认收起，状态存本地（OmniBar 是主输入方式）
  const [showTaskForm, setShowTaskForm] = useState(() => {
    try { return localStorage.getItem("plan-pilot-manual-task-form") === "1"; } catch { return false; }
  });
  const [showBlockForm, setShowBlockForm] = useState(() => {
    try { return localStorage.getItem("plan-pilot-manual-block-form") === "1"; } catch { return false; }
  });
  function toggleFormStorage(setter, key) {
    setter((cur) => {
      const next = !cur;
      try { localStorage.setItem(key, next ? "1" : "0"); } catch (e) { /* ignore */ }
      return next;
    });
  }

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
    const isToday = getLocalDate() === selectedDate;
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    const notBefore = isToday ? nowMinutes : null;
    const slot = findSlotForTask(task, planner.settings, todayBlocks, selectedDate, { notBefore });
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
    <div className="today-wrap" data-mobile-tab={mobileTab}>
      <div className="mobile-tabbar" role="tablist" aria-label="今日视图分页">
        <button
          type="button"
          role="tab"
          aria-selected={mobileTab === "plan"}
          className={mobileTab === "plan" ? "active" : ""}
          onClick={() => setMobileTab("plan")}
        >
          <Sparkles size={15} />
          规划
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mobileTab === "schedule"}
          className={mobileTab === "schedule" ? "active" : ""}
          onClick={() => setMobileTab("schedule")}
        >
          <CalendarClock size={15} />
          时间表
        </button>
      </div>
      <GreetingCard
        planner={planner}
        todayTasks={todayTasks}
        todayBlocks={todayBlocks}
        ai={ai}
        apiKey={localAiKey}
        serverKeyOk={serverAiKeyLoaded}
      />
      <div className="planner-hub">
      <OmniBar
        onExecute={onExecCommand}
        onAiChat={(text) => {
          forwardToCoach(text);
          // 转发后访谈面板轻微闪烁，引导视线到对话出现的位置
          setCoachFlash(true);
          setTimeout(() => setCoachFlash(false), 1200);
        }}
        selectedDate={selectedDate}
        todayStr={getLocalDate()}
        voiceEngine={planner.settings.voiceEngine || "stepfun"}
        voiceApiKey={voiceKey || localAiKey}
        voiceBaseUrl={planner.settings.voiceAsrBaseUrl || ""}
        voiceModel={planner.settings.voiceAsrModel || ""}
        voiceAutoSend={planner.settings.voiceAutoSend !== false}
        coachScope={planningCoach.scope}
        onScopeChange={changeCoachScope}
        onStartInterview={handleStartInterview}
      />
      <section className="coach-band">
        <div className="coach-copy">
          <div>
            <p className="eyebrow">晨间问题</p>
            <h2 style={{ color: energyColor(dayPlan.energy) }}>{formatHumanDate(selectedDate)}</h2>
            {!coachExpanded && (
              <p className="coach-summary">
                {dayPlan.morningDone ? "已保存" : dayPlan.fixed || dayPlan.topThree || dayPlan.changes ? "有未保存内容" : "未填写"}
              </p>
            )}
          </div>
          <div className="coach-head-actions">
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
            <button
              type="button"
              className="compact-action"
              onClick={startPlanningCoach}
              disabled={planningCoach.loading}
              title="AI 逐轮提问：固定安排、今日重点……直接用上方输入栏（或语音）回答"
            >
              <Sparkles size={15} />
              AI 晨间引导
            </button>
            <button
              type="button"
              className={`manual-toggle${coachExpanded ? " is-open" : ""}`}
              onClick={() => toggleFormStorage(setCoachExpanded, "plan-pilot-coach-expanded")}
            >
              <Plus size={14} /> {coachExpanded ? "收起" : "手填"}
            </button>
          </div>
        </div>
        {coachExpanded && (
        <div className="manual-form-wrap">
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
        </div>
        )}
        {aiStatus.message && <span className={`ai-message ${aiStatus.loading ? "is-loading" : ""}`}>{aiStatus.message}</span>}
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
                <div className="ai-suggestion-text">
                  <strong>{task.title}</strong>
                  <span>
                    {priorityLabel[task.priority]}优先级 · {task.estimateMinutes} 分钟
                    {task.reason ? ` · ${task.reason}` : ""}
                  </span>
                </div>
                <button
                  className="icon-button"
                  title="不要这条"
                  onClick={() => setAiTaskSuggestions((prev) => prev.filter((t) => t.id !== task.id))}
                >
                  <X size={16} />
                </button>
              </article>
            ))}
            <button className="primary-action" onClick={acceptAiTaskSuggestions}>
              <Plus size={18} />
              加入这些任务
            </button>
          </div>
        )}
      </section>

      {conversationActive && (
      <section className={`panel interview-panel${coachFlash ? " coach-flash" : ""}`}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">AI 规划访谈</p>
            <h2>让模型主动问，再帮你拆</h2>
          </div>
          <button type="button" className="icon-button" title="结束对话并收起" aria-label="结束对话并收起" onClick={closeCoachConversation}>
            <X size={16} />
          </button>
        </div>

        <div className="interview-body">
          {planningCoach.messages.length === 0 && planningCoach.suggestions.length === 0 && !planningCoach.loading && (
            <EmptyState
              illustration="chat"
              text="在上方输入栏说话或打字即可开始——AI 会逐轮提问、你回答；出现建议卡片后点「加入计划」就落成目标 / 任务。"
            />
          )}
          {(planningCoach.messages.length > 0 || planningCoach.loading) && (
            <div className="chat-scroll" ref={chatScrollRef}>
              <div className="interview-messages">
                {planningCoach.messages.map((message, index) => (
                  <div className={`chat-row ${message.role}`} key={`${message.role}-${index}`}>
                    {message.role === "assistant" && (
                      <span className="chat-avatar"><Sparkles size={13} /></span>
                    )}
                    <article className={`interview-message ${message.role}`}>
                      {message.content}
                    </article>
                  </div>
                ))}
                {planningCoach.loading && (
                  <div className="chat-row assistant">
                    <span className="chat-avatar"><Sparkles size={13} /></span>
                    <div className="chat-typing" aria-label="AI 正在输入">
                      <i /><i /><i />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
          {planningCoach.messages.length > 0 && !planningCoach.loading && (
            <p className="interview-reply-hint">在上方输入栏继续回答 ↗</p>
          )}

          {planningCoach.error && <div className="ai-error block">{planningCoach.error}</div>}

          {planningCoach.suggestions.length > 0 && (
            <div className="coach-suggestions">
              <p className="coach-suggestions-caption">AI 建议 · 确认后点「加入计划」落库</p>
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
              <button className="primary-action" onClick={handleAcceptSuggestions}>
                <Plus size={18} />
                加入计划
              </button>
            </div>
          )}
        </div>
      </section>
      )}
      </div>

      <div className="cockpit-grid">
      <section className="stats-row">
        <MetricRing done={completedCount} total={todayTasks.length} />
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
        <button
          type="button"
          className={`manual-toggle${showTaskForm ? " is-open" : ""}`}
          onClick={() => toggleFormStorage(setShowTaskForm, "plan-pilot-manual-task-form")}
        >
          <Plus size={14} /> {showTaskForm ? "收起手动添加" : "手动添加"}
        </button>
        {showTaskForm && (
        <div className="manual-form-wrap">
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
        </div>
        )}

        <div className="task-list" ref={taskListRef}>
          {overdueTasks.length > 0 && (
            <div className="overdue-zone">
              <div className="overdue-head">
                <Clock3 size={14} />
                逾期未完成 · {overdueTasks.length}
              </div>
              {visibleOverdueTasks.map((task) => (
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
          {todayTasks.length === 0 && (
            <EmptyState
              illustration="compass"
              text="先写下今天的一件具体工作。第一次用？可以填入示例数据看看完整效果。"
              action={
                loadSampleData && (
                  <button type="button" className="secondary-action empty-state-action" onClick={loadSampleData}>
                    <Sparkles size={16} />
                    一键填入示例一天
                  </button>
                )
              }
            />
          )}
          {visibleTodayTasks
            .map((task) => {
              const isEditing = editingTaskId === task.id;
              const parentGoal = task.goalId && goalById[task.goalId];

              if (isEditing) {
                return (
                  <article className="task-item editing" key={task.id} data-flip-key={task.id}>
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
                data-flip-key={task.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", task.id);
                  e.dataTransfer.effectAllowed = "copy";
                  setDragTaskId(task.id);
                }}
                onDragEnd={() => setDragTaskId(null)}
                title="拖到右侧时间轴可安排到具体时间"
              >
                <button
                  type="button"
                  className={`check-button${task.status === "done" ? " is-done" : ""}`}
                  role="checkbox"
                  aria-checked={task.status === "done"}
                  aria-label={task.status === "done" ? "标记未完成" : "标记完成"}
                  title={task.status === "done" ? "标记未完成" : "标记完成"}
                  onClick={() => {
                    const marking = task.status !== "done";
                    updateTask(task.id, { status: marking ? "done" : "open" });
                    if (marking) { playTick(planner.settings); tapDone(); }
                  }}
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
                <div className="task-actions">
                  {onStartFocus && (() => {
                    const focusableBlock = todayBlocks.find((b) => b.taskId === task.id && b.type !== "busy");
                    return focusableBlock && task.status !== "done" ? (
                      <button title="进入专注模式" className="icon-button focus-entry" onClick={() => onStartFocus(focusableBlock.id)}>
                        <Play size={17} />
                      </button>
                    ) : null;
                  })()}
                  <button title="编辑任务" className="icon-button" onClick={() => startEditingTask(task)}>
                    <Pencil size={17} />
                  </button>
                  <button title="顺延到明天" className="icon-button" onClick={() => deferTask(task.id)}>
                    <SkipForward size={17} />
                  </button>
                  <button title="删除任务" className="icon-button danger" onClick={() => deleteTask(task.id)}>
                    <Trash2 size={17} />
                  </button>
                </div>
              </article>
            );
            })}
        {(sortedTodayTasks.length > TASKS_COLLAPSED_COUNT || overdueTasks.length > OVERDUE_COLLAPSED_COUNT || futureTasks.length > 0) && (
          <button type="button" className="tasks-expand-toggle" onClick={toggleTasksExpanded}>
            {tasksExpanded ? "收起列表" : `展开全部（共 ${sortedTodayTasks.length + overdueTasks.length + futureTasks.length} 条）`}
          </button>
        )}
        {tasksExpanded && futureTasks.length > 0 && (
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
          <div className="schedule-head-actions">
            <button
              type="button"
              className={`icon-button${fitAll ? " is-on" : ""}`}
              title={fitAll ? "切回标准密度（56px/h，内部滚动）" : "适配全天：动态缩放，全天一屏放下"}
              aria-pressed={fitAll}
              onClick={() => setFitAll((v) => !v)}
            >
              <Rows3 size={17} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="全屏查看完整时间规划"
              aria-label="全屏查看时间轴"
              onClick={() => setTimelineZoom(true)}
            >
              <Maximize2 size={17} />
            </button>
          </div>
          <PipWindow
            blocks={planner.blocks}
            taskById={taskById}
            selectedDate={selectedDate}
            onCompleteTask={(taskId) => {
              updateTask(taskId, { status: "done" });
              playTick(planner.settings);
            }}
          />
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
              {schedulePreview.questions?.length
                ? `${schedulePreview.questions.length} 项需你判断（应用后在下方处理）`
                : schedulePreview.blocks.filter((b) => b.date === selectedDate).length
                  ? "全部已排入"
                  : "今天没有需要安排的任务（写了未来日期的固定安排已落到对应日期，去那天查看）。"}
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

        <button
          type="button"
          className={`manual-toggle${showBlockForm ? " is-open" : ""}`}
          onClick={() => toggleFormStorage(setShowBlockForm, "plan-pilot-manual-block-form")}
        >
          <Plus size={14} /> {showBlockForm ? "收起手动排块" : "手动排块"}
        </button>
        {showBlockForm && (
        <div className="manual-form-wrap">
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
        </div>
        )}

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
            if (t) {
              const marking = t.status !== "done";
              updateTask(t.id, { status: marking ? "done" : "open" });
              if (marking) { playTick(planner.settings); tapDone(); }
            }
          }}
          onStartFocus={onStartFocus}
          dragTask={dragTaskId ? taskById[dragTaskId] : null}
          fitAll={fitAll}
        />
      </section>
      </div>

      {timelineZoom && (
        <div className="timeline-zoom" onClick={() => setTimelineZoom(false)}>
          <div className="timeline-zoom-body" onClick={(e) => e.stopPropagation()}>
            <div className="timeline-zoom-head">
              <h2>时间分配 · {formatHumanDate(selectedDate)}</h2>
              <button type="button" className="icon-button" aria-label="退出全屏" title="退出全屏（Esc）" onClick={() => setTimelineZoom(false)}>
                <X size={18} />
              </button>
            </div>
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
                if (t) {
                  const marking = t.status !== "done";
                  updateTask(t.id, { status: marking ? "done" : "open" });
                  if (marking) { playTick(planner.settings); tapDone(); }
                }
              }}
              onStartFocus={onStartFocus}
              dragTask={dragTaskId ? taskById[dragTaskId] : null}
              fitAll
            />
          </div>
        </div>
      )}
    </div>
  );
}

