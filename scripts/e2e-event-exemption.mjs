// 事件类待办排期豁免 E2E：工作时段被占满的一天里，事件类任务自动排到时段外（晚间），
// 普通任务维持原语义进入待决问题。
import path from "node:path";
import { fileURLToPath } from "node:url";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const dir = path.join(process.env.APPDATA || "", "npm", "node_modules", "playwright");
    return import(`file:///${path.join(dir, "index.mjs").replace(/\\/g, "/")}`);
  }
}

let passCount = 0;
let failCount = 0;
const jsErrors = [];
function check(name, cond, detail = "") {
  if (cond) { console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`); passCount += 1; }
  else { console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); failCount += 1; }
}

const pwModule = await loadPlaywright();
const browser = await pwModule.chromium.launch({ headless: true });
const now = new Date();
const iso = (o) => {
  const d = new Date(now);
  d.setDate(d.getDate() + o);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const todayStr = iso(0);

const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
await ctx.route("**/api/data", (route) =>
  route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "e2e-isolated" }) }),
);
await ctx.addInitScript(([key, seed]) => localStorage.setItem(key, JSON.stringify(seed)), [
  "personal-planning-coach-v1",
  {
    settings: {
      workSegments: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "18:00" }],
      shortBreak: 10,
      longBreak: 30,
      breaks: [],
    },
    ai: { enabled: false },
    goals: [],
    tasks: [
      { id: "t-dinner", title: "晚上和老同学聚餐", date: todayStr, status: "open", estimateMinutes: 60, priority: "medium", createdAt: new Date().toISOString() },
      { id: "t-report", title: "写季度总结报告", date: todayStr, status: "open", estimateMinutes: 120, priority: "high", createdAt: new Date().toISOString() },
    ],
    blocks: [
      { id: "b-busy", type: "busy", date: todayStr, title: "全天外出评审", start: "09:00", end: "18:00", auto: false },
    ],
    dayPlans: {},
    reviews: [],
    recurring: [],
  },
]);
const page = await ctx.newPage();
page.on("pageerror", (e) => jsErrors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("503")) jsErrors.push(m.text()); });

await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
await page.waitForTimeout(700);

// 点击「自动安排」
const autoBtn = page.locator('button:has-text("自动安排")').first();
await autoBtn.click();
await page.waitForTimeout(600);

// 方案预览需要确认？查找确认按钮（应用/应用方案）
let appliedDirectly = false;
for (const label of ["应用", "应用方案", "确认应用"]) {
  const btn = page.locator(`button:has-text("${label}")`).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    appliedDirectly = true;
    await page.waitForTimeout(500);
    break;
  }
}
console.log(appliedDirectly ? "(通过预览确认应用)" : "(无预览直接生效)");

const state = await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem("personal-planning-coach-v1"));
  const blocksToday = (s.blocks || []).filter((b) => b.date === JSON.parse(localStorage.getItem("personal-planning-coach-v1")).lastSelectedDate || b.date);
  void blocksToday;
  return { blocks: s.blocks || [], tasks: s.tasks || [] };
});

const dinner = state.blocks.find((b) => b.taskId === "t-dinner");
check("E2E-1: 聚餐块生成且位于工作时段外", !!dinner && dinner.start >= "18:00", dinner ? `${dinner.start}~${dinner.end} flag=${!!dinner.outsideWindow}` : "未找到");
check("E2E-2: 带豁免标记", Boolean(dinner?.outsideWindow));
check("E2E-3: 不与全天忙块重叠", !dinner || !(dinner.start < "18:00" && dinner.end > "09:00"));
// 普通任务：没有空闲工作时段 → 待决问题；若已放置必须仍在段内
const reportBlock = state.blocks.find((b) => b.taskId === "t-report");
if (reportBlock) check("E2E-4: 普通任务若被放置仍在段内", reportBlock.start >= "09:00" && reportBlock.end <= "18:00", `${reportBlock.start}`);
else check("E2E-4: 普通任务未违规放置", true, "留在待决问题");

check("E2E-5: 无页面 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 2).join("|"));

console.log(failCount === 0 ? "\n全部通过" : `\n${failCount} 项失败`);
process.exitCode = failCount === 0 ? 0 : 1;
await browser.close();
