import { CheckCircle2, ListTodo, Plus, Wand2 } from "lucide-react";
import { formatHumanDate } from "../utils/dateTime.js";
import { priorityOrder, priorityLabel, goalTypeLabel } from "../constants/labels.js";
import { EmptyState } from "../components/EmptyState.jsx";
import { GoalGantt } from "../components/gantt/GoalGantt.jsx";

export function GoalsView({
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

        {aiStatus.message && <div className={`ai-message block ${aiStatus.loading ? "is-loading" : ""}`}>{aiStatus.message}</div>}
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


