// 目标甘特图 E2E：按钮/滚轮缩放时间刻度、拖拽 bar 平移起止日期、无关交互零回归。
// 运行：npm run test:e2e:gantt（需 dev server 已在 5173）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (e1) {
    const dir = path.join(process.env.APPDATA || "", "npm", "node_modules", "playwright");
    return import(`file:///${path.join(dir, "index.mjs").replace(/\\/g, "/")}`);
  }
}

let passCount = 0;
let failCount = 0;
const jsErrorsAll = [];
function check(name, cond, detail = "", { optional = false } = {}) {
  if (cond) {
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
    passCount += 1;
  } else {
    console.log(`${optional ? "SKIP" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!optional) failCount += 1;
  }
}

function makeBrowser() {
  const pwPromise = loadPlaywright();
  return {
    async launch(opts) {
      const pw = await pwPromise;
      this._pw = pw;
      return pw.chromium.launch(opts);
    },
  };
}
const pwLoader = makeBrowser();

async function openSeededGoalsPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  // 隔离文件后端：拦截 /api/data 避免 GET 覆盖种子
  await ctx.route("**/api/data", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "e2e-isolated" }) }),
  );
  const now = new Date();
  const iso = (offsetDays) => {
    const d = new Date(now);
    d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const seed = {
    settings: {
      workSegments: [{ start: "08:00", end: "12:00" }, { start: "13:00", end: "18:00" }],
      shortBreak: 10,
      longBreak: 30,
      maxWorkMinutes: 480,
      breaks: [],
    },
    ai: { enabled: false },
    goals: [
      {
        id: "g-e2e-explicit",
        title: "甘特显式日期目标",
        type: "month",
        priority: "medium",
        status: "active",
        progress: 40,
        parentId: "",
        startDate: iso(-2),
        endDate: iso(4),
      },
      {
        id: "g-e2e-derived",
        title: "甘特派生跨度目标",
        type: "week",
        priority: "low",
        status: "active",
        progress: 10,
        parentId: "",
        startDate: "",
        endDate: "",
      },
    ],
    tasks: [],
    blocks: [],
    dayPlans: {},
    reviews: [],
    recurring: [],
  };
  await ctx.addInitScript(
    ([key, data]) => localStorage.setItem(key, JSON.stringify(data)),
    ["personal-planning-coach-v1", seed],
  );
  const page = await ctx.newPage();
  page.on("pageerror", (err) => jsErrorsAll.push(err.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("503")) jsErrorsAll.push(m.text());
  });
  await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.locator('button[aria-label="目标"]').click();
  await page.waitForTimeout(400);
  return { ctx, page, iso };
}

// 在甘特轴上读取「首个 tick 的中心 x」换算当前窗口可见天数（首末 tick 差 × 系数不可靠，改为直接读 zoom 相关 DOM 特征）
async function axisTickTexts(page) {
  return page.evaluate(() => [...document.querySelectorAll(".gantt-tick")].map((t) => t.textContent.trim()));
}

(async () => {
  const browser = await pwLoader.launch({ headless: true });
  let ganttTop = null;

  // ========== 场景 A：加载基线 ==========
  {
    const { ctx, page } = await openSeededGoalsPage(browser);
    ganttTop = await page.evaluate(() => {
      const bars = [...document.querySelectorAll(".gantt-bar")];
      const ticks = document.querySelectorAll(".gantt-axis-track .gantt-tick").length;
      const movableBars = document.querySelectorAll(".gantt-bar.is-movable").length;
      return { bars: bars.length, ticks, movableBars };
    });
    check("A1: 两行 bar 渲染", ganttTop.bars === 2, `bars=${ganttTop.bars}`);
    check("A2: 刻度存在", ganttTop.ticks >= 2, `ticks=${ganttTop.ticks}`);
    check("A3: 仅显式日期的 bar 可拖", ganttTop.movableBars === 1, `movable=${ganttTop.movableBars}`);

    // 记录 fit 模式下第一个 bar 的几何（用于缩放回归对照）
    const fitBarBox = await page.evaluate(() => {
      const b = document.querySelector(".gantt-bar");
      const r = b.getBoundingClientRect();
      return { left: Math.round(r.left), width: Math.round(r.width), text: b.textContent.trim() };
    });
    check("A4: fit 模式 bar 有宽度", fitBarBox.width > 20, `width=${fitBarBox.width}`);

    // ========== 场景 B：按钮缩小（看更多天）→ bar 变窄；重置恢复 ==========
    await page.locator('button[aria-label="缩小时间刻度"]').click();
    await page.waitForTimeout(200);
    const outBar = await page.evaluate(() => Math.round(document.querySelector(".gantt-bar").getBoundingClientRect().width));
    check("B1: 缩小后 bar 变窄", outBar < fitBarBox.width - 8, `${fitBarBox.width} → ${outBar}`);
    const resetBtnVisible = await page.locator('button[title="重置为适应内容"]').isVisible().catch(() => false);
    check("B2: 出现重置按钮", resetBtnVisible);

    await page.locator('button[aria-label="放大时间刻度"]').click(); // 回到接近初始档位? 不一定与 fit 相同 → 用重置验证
    await page.waitForTimeout(150);
    await page.locator('button[title="重置为适应内容"]').click();
    await page.waitForTimeout(200);
    const backBar = await page.evaluate(() => Math.round(document.querySelector(".gantt-bar").getBoundingClientRect().width));
    check("B3: 重置回到 fit 宽度", Math.abs(backBar - fitBarBox.width) <= 2, `${backBar} vs ${fitBarBox.width}`);

    // 连续放大到最小档位：按钮应禁用
    for (let i = 0; i < 6; i += 1) {
      const disabled = await page.locator('button[aria-label="放大时间刻度"]').isDisabled().catch(() => true);
      if (disabled) break;
      await page.locator('button[aria-label="放大时间刻度"]').click();
      await page.waitForTimeout(120);
    }
    const inDisabled = await page.locator('button[aria-label="放大时间刻度"]').isDisabled().catch(() => true);
    check("B4: 到达最小档位时放大按钮禁用", inDisabled);
    await ctx.close();
  }

  // ========== 场景 C：滚轮缩放（锚点行为 + 页面不滚动）==========
  {
    const { ctx, page } = await openSeededGoalsPage(browser);
    await page.locator(".goal-gantt-panel").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const beforeTicks = await axisTickTexts(page);
    const box = await page.locator(".gantt-axis-track").boundingBox();
    const anchorX = box.x + box.width * 0.7;
    const anchorY = box.y + box.height / 2;
    const winScrollBefore = await page.evaluate(() => document.querySelector(".workspace").scrollTop || 0);
    // 放大：wheel deltaY < 0
    await page.mouse.move(anchorX, anchorY);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(250);
    const afterInTicks = await axisTickTexts(page);
    check("C1: 滚轮放大改变刻度", afterInTicks.join("|") !== beforeTicks.join("|"), `${beforeTicks.length}→${afterInTicks.length} ticks`);

    const pageScrolled = await page.evaluate(() => document.querySelector(".workspace").scrollTop || 0);
    check("C2: 滚轮未引发页面滚动", pageScrolled === winScrollBefore, `${winScrollBefore} → ${pageScrolled}`);
    await ctx.close();
  }

  // ========== 场景 D：拖拽 bar 平移三天 ==========
  {
    const { ctx, page, iso } = await openSeededGoalsPage(browser);
    await page.locator(".goal-gantt-panel").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const origStart = iso(-2);
    const origEnd = iso(4);

    const dragInfo = await page.evaluate(() => {
      const bar = document.querySelector(".gantt-bar.is-movable");
      return { barX: bar.getBoundingClientRect().x + 1, barY: undefined };
    });
    void dragInfo; // 仅确认存在可拖 bar

    // 视窗天数未知（fit），以像素位移近似 3 天：显式目标 span 是 -2..+4 共 7 天 ⇒ bar 像素宽 ≈ 7 天
    const barBox = await page.locator(".gantt-bar.is-movable").boundingBox();
    const barWidth = barBox.width;
    const centerX = barBox.x + barWidth / 2;
    const centerY = barBox.y + barBox.height / 2;
    const dx = barWidth * (3 / 7);

    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX + dx, centerY, { steps: 12 });
    await page.waitForTimeout(80);
    // 拖拽中预览：bar 有 --bar-shift CSS 变量且类名 is-dragging
    const midState = await page.evaluate(() => {
      const bar = document.querySelector(".gantt-bar.is-movable");
      return {
        dragging: bar.classList.contains("is-dragging"),
        shiftVar: bar.style.getPropertyValue("--bar-shift"),
      };
    });
    check("D1: 拖拽中 is-dragging 且有预览位移", midState.dragging && midState.shiftVar !== "", JSON.stringify(midState));

    await page.mouse.up();
    await page.waitForTimeout(500);

    const saved = await page.evaluate(() => {
      const raw = localStorage.getItem("personal-planning-coach-v1");
      const g = JSON.parse(raw).goals.find((x) => x.id === "g-e2e-explicit");
      return { startDate: g.startDate, endDate: g.endDate };
    });
    const diffDay = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
    const shift = diffDay(origStart, saved.startDate);
    check("D2: 整体平移约 +3 天", shift >= 2 && shift <= 4, `shift=${shift} 天`);
    const durBefore = diffDay(origStart, origEnd);
    const durAfter = diffDay(saved.startDate, saved.endDate);
    check("D3: 时长保持不变", durBefore === durAfter, `${durBefore} == ${durAfter}`);

    // ========== 场景 E：零回归抽查——状态选择器仍可用、无 JS 错误 ==========
    await page.selectOption(".gantt-status >> nth=0", "done");
    await page.waitForTimeout(300);
    const statusNow = await page.evaluate(() => {
      const g = JSON.parse(localStorage.getItem("personal-planning-coach-v1")).goals.find((x) => x.id === "g-e2e-explicit");
      return g.status;
    });
    check("E1: 下拉改状态仍生效", statusNow === "done", `status=${statusNow}`);
    await ctx.close();
  }

  check("无页面 JS 错误", jsErrorsAll.length === 0, jsErrorsAll.slice(0, 2).join(" | "));

  console.log(failCount === 0 ? "\n全部通过" : `\n${failCount} 项失败`);
  process.exitCode = failCount === 0 ? 0 : 1;
  await browser.close();
})();
