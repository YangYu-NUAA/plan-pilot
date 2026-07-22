import { Moon, RefreshCw, Send } from "lucide-react";
import { formatHumanDate } from "../utils/dateTime.js";

export function ReviewView({
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

