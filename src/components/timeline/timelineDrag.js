// 时间轴拖放的纯计算：DOM 事件与 React 状态只负责提供最新几何信息。
// 这些函数由 node:test 直接覆盖，重点验证自动滚动后的落点、移动量与取消语义。

/** 把视口纵坐标换算到时间轴内容分钟；scrollTop 是内容被卷走的距离。 */
export function minuteAtClientY(
  clientY,
  { top, scrollTop = 0, dayStart = 0, dayEnd = 1440, pixelsPerMinute, padding = 8, snapMinutes = 15 },
) {
  const minute = dayStart + (clientY - top - padding + scrollTop) / pixelsPerMinute;
  return Math.max(dayStart, Math.min(dayEnd, Math.round(minute / snapMinutes) * snapMinutes));
}

/** 指针位移加容器滚动补偿，吸附到 5 分钟。 */
export function pointerDeltaMinutes(
  clientY,
  { startY, scrollTop = 0, startScrollTop = 0, pixelsPerMinute },
) {
  if (!Number.isFinite(pixelsPerMinute) || pixelsPerMinute <= 0) return 0;
  const y = Number.isFinite(clientY) ? clientY : startY;
  const panPx = scrollTop - startScrollTop;
  return Math.round((y - startY + panPx) / pixelsPerMinute / 5) * 5;
}

/**
 * 结束一次内部块拖拽并返回提交参数；pointercancel 传 cancelled=true，绝不产生提交。
 * clientY/scrollTop 必须取结束时的最新值，不能依赖上一个 pointermove 缓存的 deltaMin。
 */
export function settlePointerDrag(
  drag,
  { clientY, scrollTop = 0, startScrollTop = 0, pixelsPerMinute, cancelled = false } = {},
) {
  if (cancelled || !drag) return null;
  const deltaMin = pointerDeltaMinutes(clientY, {
    startY: drag.startY,
    scrollTop,
    startScrollTop,
    pixelsPerMinute,
  });
  if (!deltaMin) return null;

  if (drag.mode === "resize") {
    return {
      id: drag.id,
      start: drag.origStart,
      end: Math.max(drag.origStart + 15, drag.origEnd + deltaMin),
    };
  }
  const start = drag.origStart + deltaMin;
  return { id: drag.id, start, end: start + drag.origEnd - drag.origStart };
}
