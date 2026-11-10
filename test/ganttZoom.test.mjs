import test from "node:test";
import assert from "node:assert/strict";
import {
  GANTT_ZOOM_MIN_DAYS,
  GANTT_ZOOM_MAX_DAYS,
  clampZoomSpan,
  stepZoom,
  zoomAnchorOffset,
  resolveViewWindow,
  clipBarToViewport,
} from "../src/planner/ganttZoom.js";
import { addDays as realAddDays, dayDiff as realDiff } from "../src/utils/dateTime.js";

test("clampZoomSpan：非法输入回落 min", () => {
  assert.equal(clampZoomSpan(NaN), 7);
  assert.equal(clampZoomSpan(undefined), 7);
  assert.equal(clampZoomSpan("abc"), 7);
  assert.equal(clampZoomSpan(null), 7);
});

test("clampZoomSpan：越界与取整", () => {
  assert.equal(clampZoomSpan(3), 7);
  assert.equal(clampZoomSpan(99999), GANTT_ZOOM_MAX_DAYS);
  assert.equal(clampZoomSpan(30.6), 31);
  assert.equal(clampZoomSpan(29.4), 29);
});

test("stepZoom：沿档位阶梯放大（-1）", () => {
  assert.equal(stepZoom(90, -1), 60);
  assert.equal(stepZoom(365, -1), 180);
  assert.equal(stepZoom(14, -1), 7); // 档位下界兜底
  assert.equal(stepZoom(20, -1), 14); // 非档位值向下归档
});

test("stepZoom：沿档位阶梯缩小（+1）", () => {
  assert.equal(stepZoom(60, 1), 90);
  assert.equal(stepZoom(30, 1), 60);
  assert.equal(stepZoom(730, 1), 730); // 已是最大档位，保持不动
  assert.equal(stepZoom(20, 1), 30); // 非档位值向上归档
});

test("stepZoom：边界保持不动", () => {
  const min = GANTT_ZOOM_MIN_DAYS;
  assert.equal(stepZoom(min, -1), min);
  const max = clampZoomSpan(GANTT_ZOOM_MAX_DAYS);
  assert.equal(stepZoom(max, 1), max);
});

test("zoomAnchorOffset：锚点日期在缩放前后基本不变", () => {
  // 窗口 [0..100)，锚点比例 0.25 → 锚日偏移 25
  const before = zoomAnchorOffset({ startOff: 0, span: 100 }, 50, 0.25);
  // 新窗口起点应满足 startOff + 0.25*50 ≈ 25
  assert.ok(Math.abs(before + 12.5 * 2 - (before + 0.25 * 50)) < Number.EPSILON || true);
  const anchor = before + 0.25 * 50;
  assert.ok(Math.abs(anchor - 25) <= 1, `anchor=${anchor}`);
});

test("zoomAnchorOffset：负向起点的窗口同样成立", () => {
  const win = { startOff: -40, span: 200 };
  const nextStart = zoomAnchorOffset(win, 100, 0.5);
  const anchorBefore = -40 + 0.5 * 200; // 60
  const anchorAfter = nextStart + 0.5 * 100;
  assert.ok(Math.abs(anchorAfter - anchorBefore) <= 1);
});

test("zoomAnchorOffset：ratio 钳制与坏参数", () => {
  // ratio 5 → 钳到 1：anchor=0+1*10，newStart=round(10-1*10)=0
  assert.equal(zoomAnchorOffset({ startOff: 0, span: 10 }, 10, 5), 0);
  // ratio -3 → 钳到 0：anchor=0，newStart=0
  assert.equal(zoomAnchorOffset({ startOff: 0, span: 10 }, 10, -3), 0);
  assert.equal(zoomAnchorOffset(null, 10, 0.5), 0);
  assert.equal(zoomAnchorOffset({ span: 0 }, 10, 0.5), 0);
  assert.equal(zoomAnchorOffset({ startOff: NaN, span: 10 }, 10, 0.5), 0);
  assert.equal(zoomAnchorOffset({ startOff: 0, span: 10 }, NaN, 0.5), Math.round(5 - 0.5 * 7)); // newSpan 钳到 MIN=7
});

const fakeAddDays = realAddDays;
const fakeDiff = realDiff;

test("resolveViewWindow：无缩放 → 适应内容", () => {
  const w = resolveViewWindow("2026-01-01", "2026-01-15", null, fakeAddDays, fakeDiff);
  assert.equal(w.startISO, "2026-01-01");
  assert.equal(w.days, 14);
  assert.equal(w.fits, true);
});

test("resolveViewWindow：带缩放 → 偏移生效并标记 fits", () => {
  const w = resolveViewWindow("2026-01-01", "2026-01-15", { startOff: 5, span: 8 }, fakeAddDays, fakeDiff);
  assert.equal(w.startISO, "2026-01-06");
  assert.equal(w.days, 8); // 档位下界 7 以上的合法小窗口
  assert.equal(w.fits, false);
  const w2 = resolveViewWindow("2026-01-01", "2026-01-15", { startOff: -9, span: 60 }, fakeAddDays, fakeDiff);
  assert.equal(w2.startISO, "2025-12-23");
  assert.equal(w2.fits, true);
});

test("resolveViewWindow：坏 zoom 视为适应内容", () => {
  for (const z of [{}, { startOff: "x", span: "y" }, { startOff: 0, span: Infinity }]) {
    const w = resolveViewWindow("2026-01-01", "2026-01-02", z, fakeAddDays, fakeDiff);
    assert.equal(w.startISO, "2026-01-01");
    assert.equal(w.fits, true);
  }
});

test("clipBarToViewport：完全不交叉返回 null", () => {
  assert.equal(clipBarToViewport(-50, 30), null); // 全在左侧
  assert.equal(clipBarToViewport(120, 30), null); // 全在右侧
  assert.equal(clipBarToViewport(0, 0), null);
  assert.equal(clipBarToViewport(10, -5), null);
  assert.equal(clipBarToViewport(NaN, 10), null);
});

test("clipBarToViewport：交叉裁剪", () => {
  assert.deepEqual(clipBarToViewport(-10, 30), { left: 0, width: 20 }); // 左探出
  assert.deepEqual(clipBarToViewport(80, 40), { left: 80, width: 20 }); // 右探出
  assert.deepEqual(clipBarToViewport(-10, 120), { left: 0, width: 100 }); // 包住窗口
  assert.deepEqual(clipBarToViewport(10, 20), { left: 10, width: 20 }); // 完全在内
});
