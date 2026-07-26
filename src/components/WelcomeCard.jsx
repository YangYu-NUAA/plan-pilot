import { CalendarClock, Check, ListTodo, Sparkles, Target } from "lucide-react";
import { BrandMark } from "./ui/BrandMark.jsx";

// 首次使用引导：仅在「完全空白 + 未曾关闭」时出现。
// 三个步骤的完成态从 planner 实时推导——设了工作时段 / 建了目标 / 加了任务自动打勾。
export function WelcomeCard({ planner, onOpenSettings, onGoGoals, onLoadSample, onDismiss, onHide }) {
  const steps = [
    {
      done: (planner.settings.workSegments || []).length > 0,
      icon: CalendarClock,
      title: "设定工作时段",
      desc: "告诉它你每天哪几个小时可被安排",
      action: onOpenSettings,
      actionLabel: "去设置",
    },
    {
      done: planner.goals.length > 0,
      icon: Target,
      title: "写下第一个目标",
      desc: "本周 / 月度 / 长期，目标会统领任务与时间块",
      action: onGoGoals,
      actionLabel: "去目标视图",
    },
    {
      done: planner.tasks.length > 0,
      icon: ListTodo,
      title: "排进今天",
      desc: "⌘K 输入「明天下午3点 写周报 30分钟」，或在任务栏直接添加",
      action: null,
      actionLabel: "",
    },
  ];

  return (
    <div className="welcome-overlay" onClick={onHide || onDismiss}>
      <div className="welcome-card" role="dialog" aria-label="欢迎使用" onClick={(e) => e.stopPropagation()}>
        <div className="welcome-brand">
          <span className="welcome-mark"><BrandMark size={26} /></span>
          <div>
            <h2>欢迎来到 Plan Pilot</h2>
            <p>把大目标拆到「今天先做哪一步」的本地优先规划助手。三步上手：</p>
          </div>
        </div>
        <ol className="welcome-steps">
          {steps.map((step, idx) => (
            <li key={idx} className={step.done ? "done" : ""}>
              <span className="welcome-step-check">{step.done ? <Check size={14} /> : idx + 1}</span>
              <span className="welcome-step-icon"><step.icon size={16} /></span>
              <div className="welcome-step-body">
                <strong>{step.title}</strong>
                <span>{step.desc}</span>
              </div>
              {step.action && !step.done && (
                <button type="button" className="compact-action" onClick={step.action}>
                  {step.actionLabel}
                </button>
              )}
            </li>
          ))}
        </ol>
        <div className="welcome-actions">
          {onLoadSample && (
            <button
              type="button"
              className="primary-action"
              onClick={() => {
                onLoadSample();
                onDismiss();
              }}
            >
              <Sparkles size={16} />
              填入示例数据看看
            </button>
          )}
          <button type="button" className="secondary-action" onClick={onDismiss}>
            自己从头开始
          </button>
        </div>
      </div>
    </div>
  );
}
