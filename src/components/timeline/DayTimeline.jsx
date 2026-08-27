import { useState, useEffect, useRef } from "react";
import { CheckSquare, Pencil, Play, Square, Trash2 } from "lucide-react";
import { getLocalDate, toMinutes, toTime } from "../../utils/dateTime.js";
import { isMeetingSentence } from "../../planningSemantics.js";
import { estimateMinutesForTitle } from "../../planner/textExtract.js";
import { EmptyState } from "../../components/EmptyState.jsx";
import { edgeScrollSpeed, clampScroll, findScrollableAncestor } from "./autoScroll.js";

export function DayTimeline({ blocks, taskById, settings, selectedDate, onReschedule, onDropTask, onEdit, onDelete, onToggleDone, onStartFocus, dragTask, fitAll = false }) {
  const PXH_STD = 56; // 标准密度：每小时像素
  const segs = settings.workSegments || [];
  const hasContent = segs.length > 0 || blocks.length > 0; // 是否有可显示内容（否则给空态提示）
  const [drag, setDrag] = useState(null); // { id, mode:"move"|"resize", startY, origStart, origEnd, deltaMin }
  const rootRef = useRef(null); // 容器，用于把落点 clientY 换算成分钟
  const [dropMin, setDropMin] = useState(null); // 外部任务拖入时的落点指示（分钟）
  const [viewH, setViewH] = useState(0); // fitAll 模式下的面板可视高度

  // 适配全天：监听面板高度，内容范围（工作时段+块 ±30min）一屏放下
  useEffect(() => {
    if (!fitAll || !rootRef.current) return undefined;
    const ro = new ResizeObserver((entries) => {
      setViewH(entries[0]?.contentRect.height || 0);
    });
    ro.observe(rootRef.current);
    return () => ro.disconnect();
  }, [fitAll]);

  // —— 拖拽自动跟随滚动 ——
  // 场景：页面滚到底部拖外部任务时看不到时间轴；或拖到时间轴内想落的时段不在可视区。
  // 行为：拖拽期间指针贴近视口/画布上下边缘就匀速平移——
  //   在时间轴矩形内 → 平移内部 scrollTop 露出更早/更晚时段；
  //   在矩形外（时间轴被卷走）→ 滚动最近的可滚祖先把时间轴带回视野。
  // 纯数值计算都在 ./autoScroll.js（可单测），这里只做 DOM 应用与生命周期。
  const scrollAnim = useRef({ rafId: 0, lastTs: 0, pointerY: null, scrollAnchor: null });
  const ptrDragActive = useRef(false); // 内部块正在被 pointer 拖拽（移动/缩放）
  const htmlDragActive = useRef(false); // 外部任务卡 HTML5 拖拽进行中

  function tick(ts) {
    const st = scrollAnim.current;
    st.rafId = 0;
    if (!(ptrDragActive.current || htmlDragActive.current) || st.pointerY == null) return;
    const el = rootRef.current;
    if (!el) return;
    const dt = Math.min(100, ts - (st.lastTs || ts)); // 切页回来不跳变
    st.lastTs = ts;
    const y = st.pointerY;
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const visibleH = Math.min(rect.bottom, vh) - Math.max(rect.top, 0);
    // 只有时间轴“足够可见”才走内部平移；否则（如刚从页底被拉出、只露一条细缝时）
    // 继续页面级滚动把整块带出来，避免在看不见的内部内容上空转卡住。
    const visibleEnough = visibleH >= Math.min(rect.height * 0.5, 180);

    if (y >= rect.top && y <= rect.bottom && visibleEnough) {
      const speed = edgeScrollSpeed(y, rect.top, rect.bottom);
      if (speed !== 0) applyNodeScroll(el, (speed * dt) / 1000);
    } else {
      const anc = findScrollableAncestor(el.parentElement);
      if (anc) {
        const ancRect = anc.getBoundingClientRect();
        const speed = edgeScrollSpeed(y, ancRect.top, ancRect.bottom);
        if (speed !== 0) applyNodeScroll(anc, (speed * dt) / 1000);
      }
    }
    st.rafId = requestAnimationFrame(tick);
  }
  function ensureLoop() {
    const st = scrollAnim.current;
    if (!st.rafId) {
      st.lastTs = 0; // 下一帧从 dt=0 起算
      st.rafId = requestAnimationFrame(tick);
    }
  }
  function stopLoop() {
    const st = scrollAnim.current;
    if (st.rafId) cancelAnimationFrame(st.rafId);
    st.rafId = 0;
    st.pointerY = null;
    st.scrollAnchor = null;
  }
  function applyNodeScroll(node, deltaPx) {
    const max = node.scrollHeight - node.clientHeight;
    const next = clampScroll(node.scrollTop, deltaPx, max);
    if (next !== node.scrollTop) node.scrollTop = next;
  }

  useEffect(() => {
    if (!drag) return undefined;
    function onMove(e) {
      scrollAnim.current.pointerY = e.clientY;
      ensureLoop();
      // 自动平移画布后，块与指针的相对位置由 scrollTop 增量补偿，保持「抓取点在指下」且分钟换算一致
      const panPx =
        scrollAnim.current.scrollAnchor != null && rootRef.current
          ? rootRef.current.scrollTop - scrollAnim.current.scrollAnchor
          : 0;
      const deltaMin = Math.round((e.clientY - drag.startY + panPx) / ppm / 5) * 5; // 吸附 5 分钟
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
      ptrDragActive.current = false;
      stopLoop();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      ptrDragActive.current = false;
      stopLoop();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag?.id, drag?.mode]);

  // 全天 0–24 较高、容器内部滚动；切换日期/进入时自动定位到「现在」（非今天则定位到首个块/工作开始），
  // 让关注点上方留约 1 小时，避免一进来停在凌晨空白区。fitAll 模式全天可见，无需定位。
  useEffect(() => {
    if (fitAll) return;
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
  }, [selectedDate, fitAll]);

  // 外部任务卡 HTML5 拖拽生命周期跟踪（window 级）：只认本应用任务卡发起的拖拽；
  // dragover 持续喂入指针位置驱动自动滚动探测，drop/dragend 兜底收尾（浏览器取消、Esc、丢出窗口都会触发）。
  useEffect(() => {
    function onDragStart(e) {
      const t = e.target;
      if (t instanceof Element && t.closest(".task-item.is-draggable")) {
        htmlDragActive.current = true;
        scrollAnim.current.pointerY = typeof e.clientY === "number" ? e.clientY : null;
        ensureLoop();
      }
    }
    function onWindowDragOver(e) {
      if (!htmlDragActive.current) return;
      scrollAnim.current.pointerY = e.clientY;
      ensureLoop();
    }
    function finishHtmlDrag() {
      htmlDragActive.current = false;
      stopLoop();
    }
    window.addEventListener("dragstart", onDragStart);
    window.addEventListener("dragover", onWindowDragOver);
    window.addEventListener("drop", finishHtmlDrag);
    window.addEventListener("dragend", finishHtmlDrag);
    return () => {
      finishHtmlDrag();
      window.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("dragover", onWindowDragOver);
      window.removeEventListener("drop", finishHtmlDrag);
      window.removeEventListener("dragend", finishHtmlDrag);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!hasContent) {
    return <EmptyState illustration="calendar" text="还没有时间块。先在设置里配置工作时段，或在上面加任务后点自动安排。" />;
  }
  // 标准模式：固定 00:00–24:00、56px/h，容器内部滚动；
  // fitAll 模式：范围收窄到「当日内容 ±30min」，每小时像素按面板高度动态计算，全天一屏放下。
  let pxh = PXH_STD;
  let dayStart = 0;
  let dayEnd = 1440;
  if (fitAll) {
    const pad = 30;
    const pts = [];
    segs.forEach((s) => { pts.push(toMinutes(s.start), toMinutes(s.end)); });
    blocks.forEach((b) => { pts.push(toMinutes(b.start), toMinutes(b.end)); });
    const lo = pts.length ? Math.min(...pts) : 7 * 60;
    const hi = pts.length ? Math.max(...pts) : 23 * 60;
    dayStart = Math.max(0, Math.floor((lo - pad) / 30) * 30);
    dayEnd = Math.min(1440, Math.ceil((hi + pad) / 30) * 30);
    if (viewH > 0) {
      // 下限 26px/h（再小文字不可读），上限 1.4× 标准（避免半天日程被放得过大）
      pxh = Math.max(26, Math.min(PXH_STD * 1.4, (viewH - 16) / ((dayEnd - dayStart) / 60)));
    }
  }
  const ppm = pxh / 60;
  const totalMin = dayEnd - dayStart;
  const hours = [];
  for (let m = dayStart; m < dayEnd; m += 60) hours.push(m);
  const nowDate = new Date();
  const nowMin = selectedDate === getLocalDate() ? nowDate.getHours() * 60 + nowDate.getMinutes() : null;

  // 外部任务拖入的「幽灵块」：实时预览落下后的样子——15 分钟吸附、
  // 时长取该任务已有块或估时；压到不可用/固定块上时变红提示。
  let ghost = null;
  if (dropMin != null && dragTask) {
    const existing = blocks.find((b) => b.taskId === dragTask.id && b.type !== "busy");
    const dur = existing
      ? toMinutes(existing.end) - toMinutes(existing.start)
      : Math.max(10, estimateMinutesForTitle(dragTask.title, Number(dragTask.estimateMinutes) || 30));
    const gStart = Math.max(dayStart, Math.min(dropMin, dayEnd - dur));
    const gEnd = gStart + dur;
    const clash = blocks.some((b) => {
      if (b.id === existing?.id) return false;
      if (!(b.type === "busy" || b.fixedTime)) return false;
      return toMinutes(b.start) < gEnd && gStart < toMinutes(b.end);
    });
    ghost = { start: gStart, end: gEnd, dur, clash, title: dragTask.title };
  }

  function startDrag(e, block, mode) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    ptrDragActive.current = true;
    scrollAnim.current.pointerY = e.clientY;
    // 锚定起始 scrollTop：之后的增量即「自动平移量」，折算进 deltaMin 保持分钟换算一致
    scrollAnim.current.scrollAnchor = rootRef.current ? rootRef.current.scrollTop : null;
    ensureLoop();
    setDrag({ id: block.id, mode, startY: e.clientY, origStart: toMinutes(block.start), origEnd: toMinutes(block.end), deltaMin: 0 });
  }

  // 把落点 clientY 换算成分钟（减去顶部 8px padding，吸附 15 分钟，夹在当天范围内）
  function yToMinute(clientY) {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return dayStart;
    const m = dayStart + (clientY - rect.top - 8) / ppm;
    return Math.max(dayStart, Math.min(dayEnd, Math.round(m / 15) * 15));
  }
  function onDragOverTimeline(e) {
    if (!onDropTask) return;
    e.preventDefault(); // 必须 preventDefault 才能触发 drop
    e.dataTransfer.dropEffect = "copy";
    setDropMin(yToMinute(e.clientY));
    // 拖到上/下边缘时自动滚动，够得着凌晨与深夜的时段
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const EDGE = 56;
      if (e.clientY < rect.top + EDGE) rootRef.current.scrollTop -= 14;
      else if (e.clientY > rect.bottom - EDGE) rootRef.current.scrollTop += 14;
    }
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
      {ghost && (
        <div
          className={`dt-ghost${ghost.clash ? " clash" : ""}`}
          style={{ top: (ghost.start - dayStart) * ppm + 8, height: Math.max(24, ghost.dur * ppm) }}
        >
          <span className="dt-ghost-title">{ghost.title}</span>
          <span className="dt-ghost-time">
            {ghost.clash ? "与固定安排冲突" : `${toTime(ghost.start)}–${toTime(ghost.end)}`}
          </span>
        </div>
      )}
      <div className="dt-spacer" style={{ height: totalMin * ppm + 18, pointerEvents: "none" }} />
    </div>
  );
}

