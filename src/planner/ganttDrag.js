// 目标甘特图条拖拽的纯函数判定，供组件与单元测试共用。

// 只有完全由目标自身起止日期决定的跨度才能整体平移。
// mixed 同时包含任务或子目标跨度，仅更新 goal 日期无法同步其余来源。
export function isGanttBarMovable(goal, span) {
  return Boolean(span?.derived === "explicit" && goal?.startDate && goal?.endDate);
}

// pointerup 且确有按天位移时才生成更新；pointercancel 只由组件清理预览。
export function getGanttDragUpdate(drag, eventType, addDaysFn) {
  if (eventType !== "pointerup" || !drag || drag.shift === 0) return null;
  return {
    goalId: drag.goalId,
    startDate: addDaysFn(drag.origStart, drag.shift),
    endDate: addDaysFn(drag.origEnd, drag.shift),
  };
}
