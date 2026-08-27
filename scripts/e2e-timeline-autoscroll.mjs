// E2E：时间轴拖拽自动跟随滚动（需 dev server 已在 http://127.0.0.1:5173 运行）。
// 用法：npm run test:e2e
// 无 playwright 环境、或服务未启动时优雅跳过（exit 0），不影响 npm test 主链路。
//
// 关键设计：
// - 拦截 /api/data 让应用与真实文件解耦，保证种子数据不被服务端水合覆盖；
// - 场景 A（页面级回滚带出时间轴）用矮视口制造滚动深度；
//   场景 B/C（时间轴内部平移、无关拖拽不干扰）用高视口保证面板整体可见。
import path from "node:path";
import { existsSync } from "node:fs";

const BASE = "http://127.0.0.1:5173";

async function resolvePlaywright() {
  try {
    const mod = await import("playwright");
    if (mod?.chromium) return mod;
  } catch {}
  // 回退：Windows 全局 npm 目录
  const appData = process.env.APPDATA || "";
  const globalDir = path.join(appData, "npm", "node_modules", "playwright");
  if (appData && existsSync(globalDir)) {
    try {
      const mod = await import(`file:///${path.join(globalDir, "index.mjs").replace(/\\/g, "/")}`);
      if (mod?.chromium) return mod;
    } catch {}
  }
  return null;
}

async function serverUp() {
  try {
    const res = await fetch(`${BASE}/api/ai/status`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const pw = await resolvePlaywright();
if (!pw) {
  console.log("[e2e] 未找到 playwright，跳过（本地安装后可运行）");
  process.exit(0);
}
if (!(await serverUp())) {
  console.log(`[e2e] ${BASE} 服务未启动，跳过。请先 npm run dev`);
  process.exit(0);
}

const results = [];
function check(name, ok, detail = "", { optional = false } = {}) {
  const verdict = ok ? "PASS" : optional ? "SKIP" : "FAIL";
  results.push({ name, ok, failed: !ok && !optional });
  console.log(`${verdict}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function makeSeedContext(browser, viewportH, viewportW = 1400) {
  const ctx = await browser.newContext({ viewport: { width: viewportW, height: viewportH } });
  // 拦截数据接口：返回明确错误 → 应用走「文件不可用」分支，只保留我们注入的 localStorage 种子，
  // 同时天然联动同步警告条（本次测试顺带观察其无报错即可）。
  await ctx.route("**/api/data", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "e2e-isolated" }) }),
  );
  const now = new Date();
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  await ctx.addInitScript(
    ([key, dateStr]) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            settings: {
              workSegments: [
                { start: "07:00", end: "12:00" },
                { start: "13:00", end: "23:00" },
              ],
              shortBreak: 10,
              longBreak: 30,
              maxWorkMinutes: 600,
              breaks: [],
            },
            ai: { enabled: false },
            goals: [],
            tasks: [
              {
                id: "t-e2e-1",
                title: "E2E 拖拽任务",
                date: dateStr,
                estimateMinutes: 60,
                priority: "medium",
                status: "open",
                createdAt: new Date().toISOString(),
              },
            ],
            blocks: [],
            dayPlans: {},
            reviews: [],
            recurring: [],
          }),
        );
        sessionStorage.clear();
      },
      ["personal-planning-coach-v1", iso],
  );
  return ctx;
}

const { chromium } = pw;
const browser = await chromium.launch({ headless: true });
try {
  // ---------- 公共探测 ----------
  async function openPage(ctx) {
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    return { page, pageErrors };
  }
  const feedDragOver = (page, y) =>
    page.evaluate((yv) => window.dispatchEvent(new DragEvent("dragover", { bubbles: true, clientY: yv })), y);
  async function beginHtmlDrag(page) {
    await page.locator(".task-item.is-draggable").first().evaluate((el) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "t-e2e-1");
      el.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    });
  }
  const endHtmlDrag = (page) =>
    page.evaluate(() => window.dispatchEvent(new DragEvent("drop", { bubbles: true })));

  let pageErrorsAll = [];

  // ========== 场景 A：窄视口（单列布局，时间轴下方还有访谈/统计等长内容）。页面拉到底、
  // 拖拽中指针钉在视口顶边 → 页面自动上滚把时间轴带回来。==========
  {
    const ctxA = await makeSeedContext(browser, 620, 700); // 宽度 <1180px 触发单列断点
    const { page, pageErrors } = await openPage(ctxA);
    pageErrorsAll = pageErrors.concat(pageErrorsAll);

    const tl = page.locator(".day-timeline").first();
    await page.locator(".workspace").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(300);
    const wsBeforeA = await page.locator(".workspace").evaluate((el) => el.scrollTop);
    // 矮视口下不一定能在最大滚动处完全藏住时间轴（取决于内容总高）；不可满足时标记可选跳过
    const boxA = await tl.boundingBox();
    const hiddenAbove = boxA.y + boxA.height <= 4;
    check("A 前置：时间轴已被卷出视口", hiddenAbove, `rect=${Math.round(boxA.y)}..${Math.round(boxA.y + boxA.height)}`, { optional: true });

    await beginHtmlDrag(page);
    for (let i = 0; i < 20; i += 1) {
      await feedDragOver(page, 2); // 钉在视口顶边
      await page.waitForTimeout(150);
    }
    const wsAfterA = await page.locator(".workspace").evaluate((el) => el.scrollTop);
    check("A: 贴近视口顶边时页面自动上滚带回时间轴", wsAfterA < wsBeforeA - 12, `${wsBeforeA} → ${wsAfterA}`);
    await endHtmlDrag(page);
    await page.close();
    await ctxA.close();
  }

  // ========== 场景 B/C：高视口，时间轴整体可见 ==========
  {
    const ctxBC = await makeSeedContext(browser, 1100);
    const { page, pageErrors } = await openPage(ctxBC);
    pageErrorsAll = pageErrors.concat(pageErrorsAll);

    const tl = page.locator(".day-timeline").first();
    await page.locator(".workspace").evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(200);
    // 重置内部起点（聚焦当前时间的定位效果可能已把内部顶到较高位置），并确认有真实滚动余量
    await tl.evaluate((el) => { el.scrollTop = 0; });
    const internalMax = await tl.evaluate((el) => el.scrollHeight - el.clientHeight);
    check("B 前置：内部滚动余量 ≥ 150px", internalMax >= 150, `max=${internalMax}`);

    const boxB = await tl.boundingBox();
    // 指针钉在画布真实下边缘内侧（深入边缘区）。合成事件可投递任意 clientY。
    const insideY = Math.floor(boxB.y + boxB.height - 10);
    const beforeScrollB = await tl.evaluate((el) => el.scrollTop);

    await beginHtmlDrag(page);
    for (let i = 0; i < 16; i += 1) {
      await feedDragOver(page, insideY);
      await page.waitForTimeout(150);
    }
    const afterScrollB = await tl.evaluate((el) => el.scrollTop);
    check("B: 时间轴内贴下边缘 → 内部画布向下平移", afterScrollB > beforeScrollB + 40, `${beforeScrollB} → ${afterScrollB}`);
    await endHtmlDrag(page);

    // ===== 场景 C：非任务卡发起的拖拽不应触发任何自动滚动 =====
    const cBefore = await tl.evaluate((el) => el.scrollTop);
    for (let i = 0; i < 6; i += 1) {
      await page.evaluate((yv) => {
        window.dispatchEvent(new DragEvent("dragstart", { bubbles: true }));
        window.dispatchEvent(new DragEvent("dragover", { bubbles: true, clientY: yv }));
      }, insideY);
      await page.waitForTimeout(100);
    }
    const cAfter = await tl.evaluate((el) => el.scrollTop);
    check("C: 非任务卡拖拽不改变滚动", cAfter === cBefore, `${cBefore} → ${cAfter}`);
    await page.close();
    await ctxBC.close();
  }

  check("无页面 JS 错误", pageErrorsAll.length === 0, pageErrorsAll.slice(0, 3).join(" | "));
} catch (err) {
  check("脚本执行", false, err.message);
} finally {
  await browser.close();
}

const failed = results.filter((r) => r.failed).length;
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
