// 多段任务 E2E：拆分、复制到空档、分段打卡、重新自动安排后仍保留。
// 需先在 127.0.0.1:5173 启动 npm run dev；Playwright 使用隔离浏览器上下文。
import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.route("**/api/data", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
await context.addInitScript(() => {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  localStorage.setItem("plan-pilot-onboarded", "1");
  localStorage.setItem("personal-planning-coach-v1", JSON.stringify({
    settings: {
      workSegments: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }],
      breaks: [], shortBreak: 10, longBreak: 30, maxWorkMinutes: 600,
    },
    ai: { enabled: false },
    goals: [],
    tasks: [{ id: "t-deep", title: "撰写技术路线长任务", date, estimateMinutes: 180, priority: "high", status: "open" }],
    blocks: [{ id: "b-source", taskId: "t-deep", title: "", type: "task", date, start: "09:00", end: "12:00", auto: true }],
    dayPlans: {}, reviews: [], recurring: [],
  }));
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

try {
  await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.locator(".dt-blk").waitFor();
  assert.equal(await page.locator(".dt-blk").count(), 1);

  await page.locator(".dt-blk").hover();
  await page.getByRole("button", { name: /^拆分 .* 本段$/ }).click();
  await page.waitForFunction(() => document.querySelectorAll(".dt-blk").length === 2);
  await page.waitForFunction(() => {
    const state = JSON.parse(localStorage.getItem("personal-planning-coach-v1"));
    return state.blocks.filter((block) => block.taskId === "t-deep").length === 2;
  });
  console.log("PASS 拆分：1 个长块 → 同任务 2 段");

  await page.locator(".dt-blk").first().hover();
  await page.locator(".dt-blk").first().getByRole("button", { name: /^复制 .* 本段$/ }).click();
  await page.waitForFunction(() => document.querySelectorAll(".dt-blk").length === 3);
  await page.waitForFunction(() => {
    const state = JSON.parse(localStorage.getItem("personal-planning-coach-v1"));
    return state.blocks.filter((block) => block.taskId === "t-deep").length === 3;
  });
  const copied = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("personal-planning-coach-v1"));
    return state.blocks.filter((block) => block.taskId === "t-deep").map((block) => ({ start: block.start, end: block.end, done: block.done }));
  });
  assert.equal(copied.some((block) => block.start === "14:00" && block.end === "15:30"), true);
  console.log("PASS 复制：新增段落入 14:00–15:30 真实空档，任务数仍为 1");

  for (let index = 0; index < 3; index += 1) {
    const before = await page.locator(".dt-blk.dt-done").count();
    await page.locator(".dt-blk:not(.dt-done) .dt-check").first().click();
    await page.waitForFunction((expected) => document.querySelectorAll(".dt-blk.dt-done").length === expected, before + 1);
  }
  await page.waitForTimeout(2200); // 穿越正常的 localStorage 防抖，再检查持久化后的聚合状态
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("personal-planning-coach-v1")).tasks[0].status === "done", undefined, { timeout: 5000 });
  const allDone = await page.evaluate(() => JSON.parse(localStorage.getItem("personal-planning-coach-v1")).blocks.every((block) => block.done));
  assert.equal(allDone, true);
  console.log("PASS 分段打卡：三段分别完成，全部完成后任务整体完成");

  await page.getByRole("button", { name: "自动安排" }).click();
  await page.getByRole("button", { name: "确认应用" }).click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".dt-blk").count(), 3);
  assert.deepEqual(errors, []);
  console.log("PASS 重新自动安排：三段全部保留，无页面 JS 错误");

  // 智能体入口：模拟模型用 add_session 拆分现有任务，确认后仍是一条任务 + 两个工作段。
  await context.close();
  const coachContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await coachContext.route("**/api/data", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await coachContext.route("**/api/ai/chat", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      message: "已拆成上午和下午两段。",
      done: true,
      actions: [
        { type: "add_session", taskRef: "t-coach", title: "撰写技术路线长任务", start: "09:00", end: "11:00" },
        { type: "add_session", taskRef: "t-coach", title: "撰写技术路线长任务", start: "14:00", end: "16:00" },
      ],
    }) } }] }),
  }));
  await coachContext.addInitScript(() => {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    localStorage.setItem("plan-pilot-onboarded", "1");
    localStorage.setItem("plan-pilot-ai-api-key-v1", "e2e-not-a-real-key");
    localStorage.setItem("personal-planning-coach-v1", JSON.stringify({
      settings: { workSegments: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }], breaks: [] },
      ai: { enabled: true },
      goals: [],
      tasks: [{ id: "t-coach", title: "撰写技术路线长任务", date, estimateMinutes: 240, priority: "high", status: "open" }],
      blocks: [], dayPlans: {}, reviews: [], recurring: [],
    }));
  });
  const coachPage = await coachContext.newPage();
  coachPage.on("pageerror", (error) => errors.push(error.message));
  await coachPage.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await coachPage.locator(".omnibar input").fill("把这个长任务分到上午和下午");
  await coachPage.locator(".omnibar input").press("Enter");
  await coachPage.waitForFunction(() => document.querySelectorAll(".coach-suggestion").length === 2);
  await coachPage.getByRole("button", { name: "加入计划" }).click();
  await coachPage.waitForFunction(() => {
    const state = JSON.parse(localStorage.getItem("personal-planning-coach-v1"));
    return state.blocks.filter((block) => block.taskId === "t-coach").length === 2;
  });
  const coachState = await coachPage.evaluate(() => JSON.parse(localStorage.getItem("personal-planning-coach-v1")));
  assert.equal(coachState.tasks.length, 1);
  assert.deepEqual(coachState.blocks.map((block) => [block.start, block.end]), [["09:00", "11:00"], ["14:00", "16:00"]]);
  assert.deepEqual(errors, []);
  await coachContext.close();
  console.log("PASS 智能体 add_session：两个工作段落库，任务列表仍只有 1 项");
  console.log("\n多段任务与智能体 E2E 全部通过");
} finally {
  await browser.close();
}
