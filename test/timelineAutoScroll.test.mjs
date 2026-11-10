import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_SCROLL_DEFAULTS,
  edgeScrollSpeed,
  frameDelta,
  clampScroll,
  findScrollableAncestor,
} from "../src/components/timeline/autoScroll.js";
import {
  minuteAtClientY,
  pointerDeltaMinutes,
  settlePointerDrag,
} from "../src/components/timeline/timelineDrag.js";

const { edgeZone: Z, maxSpeed: V } = AUTO_SCROLL_DEFAULTS;

// ---------- edgeScrollSpeed：分区行为 ----------

test("指针在矩形中部时速度为 0（不应自动滚动）", () => {
  const top = 100, bottom = 800;
  assert.equal(edgeScrollSpeed((top + bottom) / 2, top, bottom), 0);
  assert.equal(edgeScrollSpeed(top + Z + 1, top, bottom), 0, "刚出上边缘区应为 0");
  assert.equal(edgeScrollSpeed(bottom - Z - 1, top, bottom), 0, "刚出下边缘区应为 0");
});

test("上边缘区：越贴近上边速度越快，方向为负（向上滚）", () => {
  const top = 0, bottom = 800;
  const atEdge = edgeScrollSpeed(top, top, bottom);
  const midZone = edgeScrollSpeed(top + Z / 2, top, bottom);
  const atZoneEnd = edgeScrollSpeed(top + Z, top, bottom);

  assert.equal(atEdge, -V, "紧贴上边缘 = 最大向上速度");
  assert.ok(Math.abs(midZone) > 0 && Math.abs(midZone) < V);
  assert.ok(Math.abs(midZone) > Math.abs(atZoneEnd) && Math.abs(atZoneEnd) >= 0, "渐入：越近边缘越快");
  assert.equal(atZoneEnd, 0, "边缘区外缘速度为 0");
});

test("下边缘区：方向为正（向下滚），梯度对称", () => {
  const top = 100, bottom = 900;
  const atEdge = edgeScrollSpeed(bottom, top, bottom);
  const atMirrorDepth = edgeScrollSpeed(bottom - Z / 2, top, bottom);

  assert.equal(atEdge, V, "紧贴下边缘 = 最大向下速度");
  assert.ok(Math.abs(atMirrorDepth) > 0 && Math.abs(atMirrorDepth) < V);
  // 与上边缘镜像深度对比：|速度| 相同、符号相反
  const upperMirror = edgeScrollSpeed(top + Z / 2, top, bottom);
  assert.equal(Math.abs(atMirrorDepth), Math.abs(upperMirror));
  assert.notEqual(Math.sign(atMirrorDepth), Math.sign(upperMirror));
});

test("指针越过边缘仍保持全速（距离为负时不反向/不发散）", () => {
  const top = 200, bottom = 700;
  assert.equal(edgeScrollSpeed(-50, top, bottom), -V, "在顶边上方的越界位置按贴边处理");
  assert.equal(edgeScrollSpeed(bottom + 12345, top, bottom), V);
});

test("自定义参数生效；非法参数回退默认值或安全返回 0", () => {
  const top = 0, bottom = 500;
  assert.equal(
    edgeScrollSpeed(top + 10, top, bottom, { edgeZone: 20, maxSpeed: 400 }),
    -400 * (1 - 10 / 20),
    "自定义 zone/speed",
  );
  // 非法 options 不炸且按默认值工作
  assert.equal(edgeScrollSpeed(top + Z / 2, top, bottom, { maxSpeed: NaN }), -V / 2);
  // 宽度非法 / 翻转的矩形恒为 0
  assert.equal(edgeScrollSpeed(300, 800, 100), 0, "bottom<=top 直接 0");
  assert.equal(edgeScrollSpeed(300, 100, 100.5, { edgeZone: 0 }), 0, "edgeZone<=0 恒为 0");
});

test("clientY 为 null/NaN 时返回 0", () => {
  const top = 0, bottom = 600;
  assert.equal(edgeScrollSpeed(null, top, bottom), 0);
  assert.equal(edgeScrollSpeed(undefined, top, bottom), 0);
  assert.equal(edgeScrollSpeed(NaN, top, bottom), 0);
});

// ---------- frameDelta：帧积分 ----------

test("frameDelta 与时间成正比", () => {
  const v = 600; // px/s
  assert.ok(Math.abs(frameDelta(v, 16.7) - (v * 16.7) / 1000) < 1e-9);
  assert.equal(frameDelta(v, 1000), (v * 100) / 1000, "dt 超过上限被截断到 100ms，防跳变");
  assert.equal(frameDelta(v, 0), 0);
  assert.equal(frameDelta(v, -5), 0);
  assert.equal(frameDelta(NaN, 16), 0);
});

// ---------- clampScroll：边界钳制 ----------

test("clampScroll 正常叠加与上下界钳制", () => {
  assert.equal(clampScroll(120, 30, 500), 150);
  assert.equal(clampScroll(490, 300, 500), 500, "不超过 max");
  assert.equal(clampScroll(30, -300, 500), 0, "不低于 0");
  assert.equal(clampScroll(0, -1, 500), 0);
  assert.equal(clampScroll(0, 50, 0), 0, "max<=0 时停在 0");
  assert.equal(clampScroll(NaN, 50, 500), 50, "scrollTop 异常值按 0 处理");
  assert.equal(clampScroll(100, NaN, 500), 100, "delta 异常视为 0");
});

// ---------- 小型积分模拟：连续帧逼近滚动边界 ----------

test("模拟 rAF 连续推进：位移平滑累积且被 max 截断、不会越过边界", () => {
  let scrollTop = 20;
  const max = 300; // scrollHeight - clientHeight
  const y = 700, top = 0, bottom = 720; // 指针贴近视口底
  let ts = 0;
  let applied = 0;

  for (let i = 0; i < 60; i += 1) {
    ts += 16.7;
    const speed = edgeScrollSpeed(y, top, bottom);
    assert.ok(speed > 0, "始终朝下滚");
    const delta = frameDelta(speed, 16.7);
    const before = scrollTop;
    scrollTop = clampScroll(scrollTop, delta, max);
    applied += scrollTop - before;
    assert.ok(scrollTop >= 0 && scrollTop <= max, "任意时刻都在合法范围内");
  }
  assert.equal(scrollTop, max, "持续拖拽足够久应到达底部");
  // 纯计算无损耗：应用量 == 名义位移被截断后的结果
  assert.ok(applied <= max - 20 + 1e-6);

  // 反向验证：同一位置换到顶部边缘应单调回落
  for (let i = 0; i < 60; i += 1) {
    const speed = edgeScrollSpeed(2, top, bottom); // 近顶部
    scrollTop = clampScroll(scrollTop, frameDelta(speed, 16.7), max);
    assert.ok(scrollTop >= 0 && scrollTop <= max);
  }
  assert.equal(scrollTop, 0, "持续靠近顶部最终回到 0");
});

test("整数帧长序列的速度稳定性（16.7ms 抖动不影响总量明显偏差）", () => {
  const frames1 = Array.from({ length: 30 }, (_, i) => edgeScrollSpeed(708, 0, 720) * i === 0 ? 0 : frameDelta(edgeScrollSpeed(708, 0, 720), 16));
  const totalUniform = frames1.reduce((s, d) => s + d, 0);
  let varied = 0;
  for (let i = 0; i < 30; i += 1) varied += frameDelta(edgeScrollSpeed(708, 0, 720), 12 + (i % 9)); // 12~20ms 波动
  assert.ok(Math.abs(totalUniform - varied) < totalUniform * 0.25, "帧时长抖动对总位移影响有限");
});

// ---------- findScrollableAncestor：非浏览器环境的守卫 ----------

test("findScrollableAncestor 在无 DOM 输入下安全返回 null（Node 环境 Element 未定义也不抛错）", () => {
  assert.equal(findScrollableAncestor(null), null);
  assert.equal(findScrollableAncestor(undefined), null);
  assert.equal(findScrollableAncestor({}), null); // 非 Element 对象
});

// ---------- PR #43 rework：真实落点、内部块与取消 ----------

test("外部拖放自动滚动后，幽灵预览与真实 drop 使用同一最新 scrollTop", () => {
  const geometry = { top: 100, dayStart: 0, dayEnd: 1440, pixelsPerMinute: 1 };
  const clientY = 200;
  const before = minuteAtClientY(clientY, { ...geometry, scrollTop: 0 });
  assert.equal(before, 90);

  // 复现一帧 rAF 自动向下滚动 90px，期间不再有 dragover/pointermove。
  const scrollTop = clampScroll(0, frameDelta(900, 100), 1000);
  const ghostMinute = minuteAtClientY(clientY, { ...geometry, scrollTop });
  const dropMinute = minuteAtClientY(clientY, { ...geometry, scrollTop });

  assert.equal(scrollTop, 90);
  assert.equal(ghostMinute, 180);
  assert.equal(dropMinute, ghostMinute, "drop 与最后一帧幽灵必须一致");
  assert.notEqual(dropMinute, before, "漏加 scrollTop 会提交自动滚动前的旧落点");
});

test("内部块在指针静止时随 rAF 更新 delta，pointerup 按最新 scrollTop 提交", () => {
  const drag = { id: "block-1", mode: "move", startY: 300, origStart: 600, origEnd: 660, deltaMin: 0 };
  const geometry = { startY: drag.startY, startScrollTop: 100, pixelsPerMinute: 1 };
  assert.equal(pointerDeltaMinutes(300, { ...geometry, scrollTop: 100 }), 0);

  // 指针没有再移动，但自动滚动把容器从 100 推到 190。
  const frameDeltaMin = pointerDeltaMinutes(300, { ...geometry, scrollTop: 190 });
  assert.equal(frameDeltaMin, 90, "每帧预览包含最新滚动补偿");

  const commit = settlePointerDrag(drag, {
    clientY: 300,
    startScrollTop: 100,
    scrollTop: 190,
    pixelsPerMinute: 1,
  });
  assert.deepEqual(commit, { id: "block-1", start: 690, end: 750 });
  assert.notEqual(commit.start, drag.origStart, "静止 pointerup 也不能提交缓存的 0 delta");
});

test("内部缩放同样按结束时最新 scrollTop 结算，并保留最短 15 分钟", () => {
  const drag = { id: "block-2", mode: "resize", startY: 400, origStart: 540, origEnd: 600, deltaMin: 0 };
  const commit = settlePointerDrag(drag, {
    clientY: 400,
    startScrollTop: 50,
    scrollTop: 0,
    pixelsPerMinute: 1,
  });
  assert.deepEqual(commit, { id: "block-2", start: 540, end: 555 });
});

test("pointercancel 即使已有滚动/位移也只取消，不返回任何 reschedule 提交", () => {
  const drag = { id: "block-3", mode: "move", startY: 300, origStart: 600, origEnd: 660, deltaMin: 90 };
  const commit = settlePointerDrag(drag, {
    clientY: 500,
    startScrollTop: 100,
    scrollTop: 300,
    pixelsPerMinute: 1,
    cancelled: true,
  });
  assert.equal(commit, null);
});
