import { useLayoutEffect, useRef } from "react";

// FLIP 列表重排动画：deps 变化触发重渲染后，对比每个 [data-flip-key]
// 子元素的新旧位置，用 WAAPI 从旧位置平滑滑到新位置；新增元素淡入。
// 尊重 prefers-reduced-motion（直接跳过）。
export function useFlip(containerRef, deps) {
  const positions = useRef(new Map());
  const mounted = useRef(false);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const items = el.querySelectorAll("[data-flip-key]");
    const next = new Map();

    if (!mounted.current) {
      // 首次挂载只记录位置，不做任何动画
      items.forEach((item) => next.set(item.getAttribute("data-flip-key"), item.getBoundingClientRect()));
      positions.current = next;
      mounted.current = true;
      return;
    }

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const item of items) {
      const key = item.getAttribute("data-flip-key");
      const rect = item.getBoundingClientRect();
      next.set(key, rect);
      if (reduce) continue;
      const prev = positions.current.get(key);
      if (prev) {
        const dx = prev.left - rect.left;
        const dy = prev.top - rect.top;
        if (dx || dy) {
          item.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
            { duration: 260, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
          );
        }
      } else {
        // 新插入的条目：轻微上浮淡入
        item.animate(
          [
            { opacity: 0, transform: "translateY(-6px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: 220, easing: "ease-out" },
        );
      }
    }
    positions.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
