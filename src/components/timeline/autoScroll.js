// 拖拽自动滚动的纯计算逻辑。
// 目标：拖拽（外部任务拖入时间轴 / 已有块移动缩放）时，指针贴近视口或画布上下边缘
// 就按接近程度匀速平移，让被卷走的时间内容跟随鼠标回到视野。
// 输入输出都是无副作用的纯数值，DOM 操作由组件层负责——本文件保持可被 node:test 覆盖。

export const AUTO_SCROLL_DEFAULTS = Object.freeze({
  edgeZone: 88, // 距边缘多少像素内开始加速（合并后布局下留足减速余量，避免贴边却几乎不滚）
  maxSpeed: 900, // 紧贴边缘时的最大速度（px/秒）
});

/**
 * 指针纵向位置对应的自动滚动速度（px/秒；正值=向下滚）。
 * 只在「上边缘区 / 下边缘区」内产生速度：越贴近边缘越快、线性渐入，
 * 中间区域为 0。用于视口滚动和容器内部平移两种场景（top/bottom 传哪个矩形的值就是针对哪个矩形）。
 *
 * @param {number} clientY 当前指针 clientY
 * @param {number} top 目标矩形上边缘
 * @param {number} bottom 目标矩形下边缘
 * @param {{edgeZone?: number, maxSpeed?: number}} [options]
 * @returns {number} px/秒 的带符号速度
 */
export function edgeScrollSpeed(clientY, top, bottom, options) {
  const { edgeZone, maxSpeed } = normalizeOptions(options);
  if (!(edgeZone > 0) || !(bottom > top)) return 0;
  if (clientY == null || Number.isNaN(clientY)) return 0;

  // 上边缘区：距边越近（dist→0）速度越接近 -maxSpeed
  const distTop = clientY - top;
  if (distTop <= edgeZone) {
    const t = clamp01(1 - Math.max(0, distTop) / edgeZone);
    return t > 0 ? -t * maxSpeed : 0; // 规范化：区外缘命中时返回 +0 而非 -0
  }
  // 下边缘区：对称处理
  const distBottom = bottom - clientY;
  if (distBottom <= edgeZone) {
    const t = clamp01(1 - Math.max(0, distBottom) / edgeZone);
    return t > 0 ? t * maxSpeed : 0;
  }
  return 0;
}

/**
 * 一帧内应施加的滚动位移（px）。dt 过大时截断到 dtCapMs，
 * 避免标签页切走再回来时一次跳一大段。
 */
export function frameDelta(speedPxPerSec, dtMs, dtCapMs = 100) {
  if (!Number.isFinite(speedPxPerSec) || !Number.isFinite(dtMs) || dtMs <= 0) return 0;
  return (speedPxPerSec * Math.min(dtMs, dtCapMs)) / 1000;
}

/**
 * 把位移应用到 scrollTop 并夹在合法范围 [0, max] 内。
 * 返回新 scrollTop；不越界时等价于 scrollTop + deltaPx。
 */
export function clampScroll(scrollTop, deltaPx, max) {
  const current = Number.isFinite(scrollTop) ? scrollTop : 0;
  const limit = Number.isFinite(max) && max > 0 ? max : 0;
  const next = current + (Number.isFinite(deltaPx) ? deltaPx : 0);
  return Math.max(0, Math.min(limit, next));
}

/**
 * 从 el 的祖先里找第一个真正可滚动的元素（内容溢出且允许纵向滚动）。
 * 用于「指针在时间轴外但贴近视口边缘」时把页面滚回来。
 * 找不到返回 null（调用方自行跳过）。
 */
export function findScrollableAncestor(el) {
  let node = el;
  // typeof 守卫：纯 Node 环境没有 Element，instanceof 直接求值会报 ReferenceError
  while (node && typeof Element !== "undefined" && node instanceof Element) {
    const style = getComputedStyle(node);
    const canScrollY =
      /(auto|scroll|overlay)/.test(style.overflowY) ||
      node === document.scrollingElement;
    if (canScrollY && node.scrollHeight > node.clientHeight + 1) return node;
    node = node.parentElement;
  }
  return null;
}

function normalizeOptions(options) {
  const merged = { ...AUTO_SCROLL_DEFAULTS, ...(options || {}) };
  return {
    edgeZone: Number.isFinite(merged.edgeZone) ? merged.edgeZone : AUTO_SCROLL_DEFAULTS.edgeZone,
    maxSpeed: Number.isFinite(merged.maxSpeed) ? merged.maxSpeed : AUTO_SCROLL_DEFAULTS.maxSpeed,
  };
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
