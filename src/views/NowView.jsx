import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CalendarClock, Check, Play } from "lucide-react";
import { getLocalDate, toMinutes, toTime } from "../utils/dateTime.js";
import { sortBlocks } from "../planner/scheduling.js";
import { MetricRing } from "../components/ui/Metric.jsx";
import { Illustration } from "../components/ui/Illustration.jsx";

// 「当下」视图：打开手机第一眼只要一个答案——现在该做什么。
// 大字号当前块 + 剩余倒计时 + 完成/专注大按钮；下面是今日剩余进程。
export function NowView({ planner, taskById, goalById, onToggleTask, onStartFocus, onGoToday }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const todayStr = getLocalDate();
  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

  const { current, next, remaining, doneCount, totalCount } = useMemo(() => {
    const blocks = sortBlocks(planner.blocks.filter((b) => b.date === todayStr));
    const cur = blocks.find((b) => nowMin >= toMinutes(b.start) && nowMin < toMinutes(b.end)) || null;
    const nxt = blocks.find((b) => toMinutes(b.start) > nowMin) || null;
    const rem = blocks.filter((b) => toMinutes(b.end) > nowMin);
    const todayTasks = planner.tasks.filter((t) => t.date === todayStr);
    return {
      current: cur,
      next: nxt && nxt !== cur ? nxt : null,
      remaining: rem,
      doneCount: todayTasks.filter((t) => t.status === "done").length,
      totalCount: todayTasks.length,
    };
  }, [planner.blocks, planner.tasks, todayStr, nowMin]);

  const currentTask = current?.taskId ? taskById[current.taskId] : null;
  const currentTitle = currentTask?.title || current?.title || "";
  const currentGoal = currentTask?.goalId ? goalById[currentTask.goalId]?.title : "";

  const remainSec = current ? Math.max(0, Math.round((toMinutes(current.end) - nowMin) * 60)) : 0;
  const progress = current
    ? Math.min(1, Math.max(0, (nowMin - toMinutes(current.start)) / Math.max(1, toMinutes(current.end) - toMinutes(current.start))))
    : 0;
  const mm = String(Math.floor(remainSec / 60)).padStart(2, "0");
  const ss = String(remainSec % 60).padStart(2, "0");

  return (
    <div className="now-wrap">
      {current ? (
        <section className="now-hero">
          <p className="now-eyebrow">正在进行</p>
          <h2 className="now-title">{currentTitle || "时间块"}</h2>
          {currentGoal && <p className="now-goal">{currentGoal}</p>}
          <p className="now-time">
            {current.start}–{current.end}
          </p>
          <div className="now-count" aria-label="剩余时间">
            {mm}:{ss}
          </div>
          <div className="now-progress">
            <i style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <div className="now-actions">
            {currentTask && (
              <button type="button" className="now-btn primary" onClick={() => onToggleTask(currentTask.id)}>
                <Check size={22} />
                完成
              </button>
            )}
            <button type="button" className="now-btn secondary" onClick={() => onStartFocus(current.id)}>
              <Play size={20} />
              专注
            </button>
          </div>
        </section>
      ) : next ? (
        <section className="now-hero is-idle">
          <p className="now-eyebrow">现在空闲</p>
          <h2 className="now-title">下一个：{next.title || taskById[next.taskId]?.title || "时间块"}</h2>
          <p className="now-time">
            {next.start} 开始 · 还有 {Math.max(1, Math.round(toMinutes(next.start) - nowMin))} 分钟
          </p>
          <div className="now-actions">
            <button type="button" className="now-btn secondary" onClick={onGoToday}>
              <CalendarClock size={20} />
              去规划
            </button>
          </div>
        </section>
      ) : (
        <section className="now-hero is-idle">
          <Illustration name="compass" size={64} />
          <h2 className="now-title">今天没有安排时间块</h2>
          <p className="now-time">说一句话，让 AI 帮你把今天排出来</p>
          <div className="now-actions">
            <button type="button" className="now-btn primary" onClick={onGoToday}>
              <ArrowRight size={20} />
              去规划
            </button>
          </div>
        </section>
      )}

      <section className="now-day">
        <div className="now-day-head">
          <MetricRing done={doneCount} total={totalCount} />
          <span className="now-day-label">今日进程</span>
        </div>
        {remaining.length > 0 && (
          <ul className="now-list">
            {remaining.map((b) => {
              const isCur = current?.id === b.id;
              const title = taskById[b.taskId]?.title || b.title || (b.type === "busy" ? "固定占用" : "时间块");
              return (
                <li key={b.id} className={isCur ? "is-current" : ""}>
                  <span className="now-list-time">{b.start}</span>
                  <span className="now-list-title">{title}</span>
                  {isCur && <span className="now-list-live">进行中</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
