import { useState, useEffect, useRef } from "react";
import { CheckSquare, Clock3, Pencil, Play, Square, Trash2 } from "lucide-react";
import { getLocalDate, toMinutes, toTime } from "../../utils/dateTime.js";
import { isMeetingSentence } from "../../planningSemantics.js";
import { EmptyState } from "../../components/EmptyState.jsx";

export function DayTimeline({ blocks, taskById, settings, selectedDate, onReschedule, onDropTask, onEdit, onDelete, onToggleDone, onStartFocus }) {
  const PXH = 56; // 每小时像素
  const ppm = PXH / 60;
  const segs = settings.workSegments || [];
  const hasContent = segs.length > 0 || blocks.length > 0; // 是否有可显示内容（否则给空态提示）
  const [drag, setDrag] = useState(null); // { id, mode:"move"|"resize", startY, origStart, origEnd, deltaMin }
  const rootRef = useRef(null); // 容器，用于把落点 clientY 换算成分钟
  const [dropMin, setDropMin] = useState(null); // 外部任务拖入时的落点指示（分钟）

  useEffect(() => {
    if (!drag) return undefined;
    function onMove(e) {
      const deltaMin = Math.round((e.clientY - drag.startY) / ppm / 5) * 5; // 吸附 5 分钟
      setDrag((d) => (d ? { ...d, deltaMin } : d));
    }
    function onUp() {
      setDrag((d) => {
        if (d && d.deltaMin) {
          const dur = d.origEnd - d.origStart;
          if (d.mode === "resize") {
            onReschedule(d.id, d.origStart, Math.max(d.origStart + 15, d.origEnd + d.deltaMin));
          } else {
            onReschedule(d.id, d.origStart + d.deltaMin, d.origStart + d.deltaMin + dur);
          }
        }
        return null;
      });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag?.id, drag?.mode]);

  // 全天 0–24 较高、容器内部滚动；切换日期/进入时自动定位到「现在」（非今天则定位到首个块/工作开始），
  // 让关注点上方留约 1 小时，避免一进来停在凌晨空白区。
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const now = new Date();
    const focusMin =
      selectedDate === getLocalDate()
        ? now.getHours() * 60 + now.getMinutes()
        : blocks.length
          ? Math.min(...blocks.map((b) => toMinutes(b.start)))
          : segs[0]
            ? toMinutes(segs[0].start)
            : 8 * 60;
    el.scrollTop = Math.max(0, (focusMin - 60) * ppm);
  }, [selectedDate]);

  if (!hasContent) {
    return <EmptyState icon={<Clock3 size={22} />} text="还没有时间块。先在设置里配置工作时段，或在上面加任务后点自动安排。" />;
  }
  // 固定显示完整一天 00:00–24:00：小时标签 0–23（最后一格 23:00），容器高度铺到 24:00，
  // 这样「现在」线在任何时刻（含 23:xx）都落在范围内、不会越出底部看不见。
  const dayStart = 0;
  const dayEnd = 1440;
  const totalMin = dayEnd - dayStart;
  const hours = [];
  for (let m = dayStart; m < dayEnd; m += 60) hours.push(m);
  const nowDate = new Date();
  const nowMin = selectedDate === getLocalDate() ? nowDate.getHours() * 60 + nowDate.getMinutes() : null;

  function startDrag(e, block, mode) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    setDrag({ id: block.id, mode, startY: e.clientY, origStart: toMinutes(block.start), origEnd: toMinutes(block.end), deltaMin: 0 });
  }

  // 把落点 clientY 换算成分钟（减去顶部 8px padding，吸附 5 分钟，夹在当天范围内）
  function yToMinute(clientY) {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return dayStart;
    const m = dayStart + (clientY - rect.top - 8) / ppm;
    return Math.max(dayStart, Math.min(dayEnd, Math.round(m / 5) * 5));
  }
  function onDragOverTimeline(e) {
    if (!onDropTask) return;
    e.preventDefault(); // 必须 preventDefault 才能触发 drop
    e.dataTransfer.dropEffect = "copy";
    setDropMin(yToMinute(e.clientY));
  }
  function onDropTimeline(e) {
    if (!onDropTask) return;
    e.preventDefault();
    const taskId = e.dataTransfer.getData("text/plain");
    const minute = yToMinute(e.clientY);
    setDropMin(null);
    if (taskId) onDropTask(taskId, minute);
  }

  return (
    <div
      className="day-timeline"
      ref={rootRef}
      style={{}} // height determined by flex layout; inner spacer keeps 24h canvas
      onDragOver={onDragOverTimeline}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDropMin(null); }}
      onDrop={onDropTimeline}
    >
      {hours.map((m) => (
        <div className="dt-hour" key={m} style={{ top: (m - dayStart) * ppm + 8 }}>
          <span>{toTime(m)}</span>
        </div>
      ))}
      {/* 半小时虚线刻度，帮助目测 30 分钟粒度 */}
      {hours.map((m) => (
        <div className="dt-half" key={`half-${m}`} style={{ top: (m + 30 - dayStart) * ppm + 8 }} />
      ))}
      {/* 工作时段背景带：一眼看出今天的可用时间 */}
      {segs.map((seg) => (
        <div
          className="dt-seg"
          key={`seg-${seg.start}-${seg.end}`}
          style={{
            top: (toMinutes(seg.start) - dayStart) * ppm + 8,
            height: (toMinutes(seg.end) - toMinutes(seg.start)) * ppm,
          }}
        />
      ))}
      {blocks.map((block) => {
        const task = taskById[block.taskId];
        const busy = block.type === "busy" || (!block.taskId && !block.auto);
        const title = task?.title || block.title || (busy ? "固定占用" : "自定义安排");
        const isDragging = drag?.id === block.id;
        const dMove = isDragging && drag.mode === "move" ? drag.deltaMin : 0;
        const dResize = isDragging && drag.mode === "resize" ? drag.deltaMin : 0;
        const startMin = toMinutes(block.start) + dMove;
        const endMin = toMinutes(block.end) + dMove + dResize;
        const top = (startMin - dayStart) * ppm + 8;
        const h = Math.max(30, (endMin - startMin) * ppm);
        let cls = "deep";
        if (busy) cls = isMeetingSentence(title) ? "meet" : "busy";
        else if (task?.kind === "fixed") cls = "meet";
        else if (task?.priority === "high") cls = "priority-high";
        else if (task?.priority === "medium") cls = "priority-medium";
        else if (task?.priority === "low") cls = "priority-low";
        const col = block._col ?? 0;
        const cols = block._totalCols ?? 1;
        // 块太矮时进入紧凑模式：隐藏第二行 meta、标题垂直居中，避免文字被 overflow 裁掉
        const compact = h < 54;
        // 正在进行的块（现在落在起止之间）：加发光边框，一眼定位当下
        const isLive = nowMin != null && nowMin >= startMin && nowMin < endMin;
        // When overlapping, shift left/width so blocks render side-by-side.
        // Single blocks keep the original full-width layout (right: 2px).
        const blkStyle = cols > 1
          ? {
              top,
              height: h,
              left: `calc(50px + (100% - 52px) * ${col / cols})`,
              width: `calc((100% - 52px) / ${cols} - 2px)`,
              right: "auto",
            }
          : { top, height: h };
        return (
          <article
            className={`dt-blk dt-${cls}${isDragging ? " dragging" : ""}${task?.status === "done" ? " dt-done" : ""}${compact ? " dt-compact" : ""}${isLive ? " dt-live" : ""}`}
            key={block.id}
            style={blkStyle}
            title={`${title} · ${toTime(startMin)}–${toTime(endMin)}（${endMin - startMin} 分钟）`}
            onPointerDown={(e) => startDrag(e, block, "move")}
          >
            {!busy && block.taskId && task && onToggleDone && (
              <button
                type="button"
                className={`dt-check${task.status === "done" ? " is-done" : ""}`}
                role="checkbox"
                aria-checked={task.status === "done"}
                aria-label={task.status === "done" ? "标记未完成" : "标记完成"}
                title={task.status === "done" ? "标记未完成" : "标记完成"}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onToggleDone(block); }}
              >
                {task.status === "done" ? <CheckSquare size={16} /> : <Square size={16} />}
              </button>
            )}
            <div className="dt-body">
              <div className="dt-bt">{title}</div>
              <div className="dt-bm">
                {toTime(startMin)}–{toTime(endMin)} · {endMin - startMin}分钟
                {busy ? " · 不可用" : block.auto ? " · 自动" : ""}
              </div>
            </div>
            <div className="dt-actions">
              {!busy && block.taskId && task && onStartFocus && (
                <button title="进入专注模式" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onStartFocus(block.id); }}>
                  <Play size={14} />
                </button>
              )}
              <button title="编辑" onPointerDown={(e) => e.stopPropagation()} onClick={() => onEdit(block)}>
                <Pencil size={14} />
              </button>
              <button title="删除" onPointerDown={(e) => e.stopPropagation()} onClick={() => onDelete(block.id)}>
                <Trash2 size={14} />
              </button>
            </div>
            <div
              className="dt-resize"
              title="拖动改时长"
              onPointerDown={(e) => {
                e.stopPropagation();
                startDrag(e, block, "resize");
              }}
            />
          </article>
        );
      })}
      {nowMin != null && nowMin >= dayStart && nowMin <= dayEnd && (
        <div className="dt-now" style={{ top: (nowMin - dayStart) * ppm + 8 }}>
          <b>现在 {toTime(nowMin)}</b>
        </div>
      )}
      {dropMin != null && (
        <div className="dt-drop" style={{ top: (dropMin - dayStart) * ppm + 8 }}>
          <b>放到 {toTime(dropMin)}</b>
        </div>
      )}
      <div className="dt-spacer" style={{ height: totalMin * ppm + 18, pointerEvents: "none" }} />
    </div>
  );
}

