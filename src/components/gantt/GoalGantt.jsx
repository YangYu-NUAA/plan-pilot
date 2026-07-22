import { useState, useMemo } from "react";
import { Pencil, Target, Trash2 } from "lucide-react";
import { addDays, dayDiff, formatShortDate, getLocalDate } from "../../utils/dateTime.js";
import { goalTypeLabel } from "../../constants/labels.js";
import { buildGoalGantt } from "../../planner/gantt.js";
import { EmptyState } from "../../components/EmptyState.jsx";

export function GoalGantt({ goals, tasks, goalById, updateGoal, deleteGoal }) {
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

