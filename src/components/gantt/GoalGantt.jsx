import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { Pencil, Target, Trash2, ZoomIn, ZoomOut, Scan } from "lucide-react";
import { addDays, dayDiff, formatShortDate, getLocalDate } from "../../utils/dateTime.js";
import { goalTypeLabel } from "../../constants/labels.js";
import { buildGoalGantt } from "../../planner/gantt.js";
import { EmptyState } from "../../components/EmptyState.jsx";
import {
  GANTT_ZOOM_MIN_DAYS,
  GANTT_ZOOM_MAX_DAYS,
  stepZoom,
  zoomAnchorOffset,
  resolveViewWindow,
  clipBarToViewport,
} from "../../planner/ganttZoom.js";

export function GoalGantt({ goals, tasks, goalById, updateGoal, deleteGoal }) {
  const [editingGoalId, setEditingGoalId] = useState(null);
  const [editDraft, setEditDraft] = useState({ title: "", type: "long", priority: "medium", parentId: "", startDate: "", endDate: "" });
  const [editError, setEditError] = useState("");
  const [zoom, setZoom] = useState(null); // null = 适应内容；否则 {startOff（相对内容最早日的天偏移，可为负）, span（可视天数）}
  const rootRef = useRef(null);
  const contentRef = useRef({ min: "", max: "", days: 1 }); // 最新内容窗口，供一次性绑定的 wheel 监听读取
  const barDrag = useRef(null); // 拖拽中的条状态
  const [barDraggingGoalId, setBarDraggingGoalId] = useState(null);
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

  // —— 时间刻度缩放：窗口解析（zoom 为 null 时与旧版行为完全一致：起点 min、跨度 totalDays）——
  const view = useMemo(() => resolveViewWindow(min, max, zoom, addDays, dayDiff), [min, max, zoom]);
  const viewDays = Math.max(1, view.days);
  const viewEndISO = addDays(view.startISO, viewDays);
  const vpctRaw = useCallback(
    (date) => (dayDiff(view.startISO, date) / viewDays) * 100,
    [view.startISO, viewDays],
  );
  // 刻度保持从内容最早日起每 7 天一档的节律（与旧版完全同相），只展示落在当前窗口内的部分
  const ticks = useMemo(() => {
    const list = [];
    for (let d = min; d <= viewEndISO; d = addDays(d, 7)) {
      if (d >= view.startISO) list.push(d);
    }
    return list;
  }, [min, view.startISO, viewEndISO]);
  const showToday = today >= view.startISO && today <= viewEndISO;

  contentRef.current = { min, max, days: totalDays };

  // —— 缩放动作（按钮 / 滚轮共用）——
  const applyZoomStep = useCallback((dir, anchorRatio = 0.5) => {
    setZoom((z) => {
      const curSpan = z ? z.span : Math.max(1, contentRef.current.days);
      const curWindow = z || { startOff: 0, span: Math.max(1, contentRef.current.days) };
      const newSpan = stepZoom(curSpan, dir);
      if (newSpan === curSpan && z && z.span === newSpan) return z;
      return { startOff: zoomAnchorOffset(curWindow, newSpan, anchorRatio), span: newSpan };
    });
  }, []);

  // 滚轮缩放：绑在甘特图区域上，非 passive 以阻止页面滚动
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    function onWheel(e) {
      if (!e.deltaY) return;
      // 语义：滚轮落在甘特图上 = 缩放时间刻度，不滚动页面。
      // 防御性回卷：合成输入路径（如自动化/平滑滚动）的默认滚动可能跨多帧发生，
      // 短时窗口内强制锁回原位后自动解除。
      const ws = root.closest(".workspace") || null;
      const prevTop = ws ? ws.scrollTop : null;
      e.preventDefault();
      const track = root.querySelector(".gantt-axis-track");
      let ratio = 0.5;
      if (track) {
        const r = track.getBoundingClientRect();
        if (r.width > 0) ratio = (e.clientX - r.left) / r.width;
      }
      applyZoomStep(e.deltaY > 0 ? 1 : -1, ratio);
      if (ws && prevTop != null) {
        const lockUntil = performance.now() + 280;
        const guard = () => {
          if (performance.now() >= lockUntil) {
            ws.removeEventListener("scroll", guard);
            return;
          }
          if (ws.scrollTop !== prevTop) ws.scrollTop = prevTop;
        };
        ws.addEventListener("scroll", guard, { passive: true });
      }
    }
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [applyZoomStep, goals.length > 0]); // 空列表分支与正常分支切换时会替换 .gantt 节点，需重绑

  // —— 条拖拽（仅限显式设定了起止日期的目标）：整体平移，保持时长，按天对齐 ——
  function barMovable(goal, span) {
    return Boolean(span.derived === "explicit" && goal.startDate && goal.endDate);
  }
  function handleBarPointerDown(e, goal, span) {
    if (e.button !== 0 || !barMovable(goal, span)) return;
    const trackEl = e.currentTarget.closest(".gantt-track");
    if (!trackEl) return;
    barDrag.current = {
      goalId: goal.id,
      startX: e.clientX,
      trackW: trackEl.clientWidth || 1,
      origStart: goal.startDate,
      origEnd: goal.endDate,
      shift: 0,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.style.setProperty("--bar-shift", "0px");
    setBarDraggingGoalId(goal.id);
  }
  function handleBarPointerMove(e) {
    const drag = barDrag.current;
    if (!drag) return;
    const pxPerDay = drag.trackW / viewDays;
    const shift = Math.round((e.clientX - drag.startX) / pxPerDay);
    if (shift !== drag.shift) {
      drag.shift = shift;
      e.currentTarget.style.setProperty("--bar-shift", `${shift * pxPerDay}px`); // 预览用 CSS 变量位移，不触发重渲染
    }
  }
  function handleBarPointerUp(e) {
    const drag = barDrag.current;
    e.currentTarget?.style.removeProperty("--bar-shift");
    if (!drag) return;
    barDrag.current = null;
    setBarDraggingGoalId(null);
    if (drag.shift === 0) return;
    updateGoal(drag.goalId, {
      startDate: addDays(drag.origStart, drag.shift),
      endDate: addDays(drag.origEnd, drag.shift),
    });
  }

  if (!goals.length) {
    return (
      <section className="panel goal-gantt-panel">
        <div className="section-heading">
          <h2>目标甘特图</h2>
        </div>
        <EmptyState illustration="flag" text="还没有目标。在上方新增长期 / 月度 / 本周目标后，这里会按时间线展示。" />
      </section>
    );
  }

  return (
    <section className="panel goal-gantt-panel">
      <div className="section-heading">
        <h2>目标甘特图</h2>
        <span className="gantt-hint">跨度按关联任务的日期范围；无任务的目标按类型给默认区间（虚线条）</span>
        <div className="gantt-zoom-tools" role="group" aria-label="时间刻度缩放">
          {zoom && (
            <button className="icon-button" title="重置为适应内容" onClick={() => setZoom(null)}>
              <Scan size={15} />
            </button>
          )}
          <button
            className="icon-button"
            title="放大时间刻度（看得更细）"
            aria-label="放大时间刻度"
            disabled={Boolean(zoom) && zoom.span <= GANTT_ZOOM_MIN_DAYS}
            onClick={() => applyZoomStep(-1)}
          >
            <ZoomIn size={16} />
          </button>
          <button
            className="icon-button"
            title="缩小时间刻度（看更多天）"
            aria-label="缩小时间刻度"
            disabled={Boolean(zoom) && zoom.span >= GANTT_ZOOM_MAX_DAYS}
            onClick={() => applyZoomStep(1)}
          >
            <ZoomOut size={16} />
          </button>
        </div>
      </div>
      <div className="gantt" ref={rootRef} onWheel={(e) => e.stopPropagation()}>
        <div className="gantt-axis">
          <div className="gantt-axis-spacer" />
          <div className="gantt-axis-track">
            {ticks.map((d) => (
              <span key={d} className="gantt-tick" style={{ left: `${vpctRaw(d)}%` }}>
                {formatShortDate(d)}
              </span>
            ))}
            {showToday && (
              <span className="gantt-axis-today" style={{ left: `${Math.max(0, Math.min(100, vpctRaw(today)))}%` }}>今天</span>
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
                    <span key={d} className="gantt-grid" style={{ left: `${vpctRaw(d)}%` }} />
                  ))}
                  {showToday && <span className="gantt-track-today" style={{ left: `${Math.max(0, Math.min(100, vpctRaw(today)))}%` }} />}
                  {(() => {
                    const rawLeft = vpctRaw(span.start);
                    const rawWidth = Math.max(2.5, ((dayDiff(span.start, span.end) + 1) / viewDays) * 100);
                    const vis = clipBarToViewport(rawLeft, rawWidth);
                    if (!vis) return null; // 完全在窗口外（缩放后正常）
                    const movable = barMovable(goal, span);
                    const moveHint = movable
                      ? "拖动平移起止日期（时长不变）"
                      : span.derived === "tasks"
                        ? "跨度由关联任务决定，不可拖拽；在编辑中手动指定开始/结束后可拖动"
                        : "无手动日期范围，在编辑中设置开始/结束日期后即可拖动";
                    return (
                      <div
                        className={`gantt-bar status-${goal.status} priority-${goal.priority}${span.derived === "type" ? " estimated" : ""}${span.derived === "explicit" ? " explicit" : ""}${movable ? " is-movable" : ""}${barDraggingGoalId === goal.id ? " is-dragging" : ""}`}
                        style={{ left: `${vis.left}%`, width: `${vis.width}%` }}
                        title={`${span.start} → ${span.end}（${span.derived === "explicit" ? "手动指定" : span.derived === "tasks" ? "按关联任务" : "按类型估算"}）· ${moveHint}`}
                        onPointerDown={movable ? (e) => handleBarPointerDown(e, goal, span) : undefined}
                        onPointerMove={movable ? handleBarPointerMove : undefined}
                        onPointerUp={movable ? handleBarPointerUp : undefined}
                        onPointerCancel={movable ? handleBarPointerUp : undefined}
                      >
                        <span className="gantt-bar-fill" style={{ width: `${progress}%` }} />
                        <span className="gantt-bar-pct">{progress}%</span>
                      </div>
                    );
                  })()}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

