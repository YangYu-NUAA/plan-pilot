const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

// 必须显式使用隔离的临时 profile，防止测试误写真实计划数据。
const testProfile = path.resolve(process.env.PLAN_PILOT_USER_DATA_DIR || "");
const allowedProfilePrefixes = ["/tmp/plan-pilot-", `${path.resolve(os.tmpdir())}${path.sep}plan-pilot-`];
if (!testProfile || !allowedProfilePrefixes.some((prefix) => testProfile.startsWith(prefix))) {
  throw new Error("Set PLAN_PILOT_USER_DATA_DIR to an isolated /tmp/plan-pilot-* profile before running this test.");
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, description, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { lastError = error; }
    await pause(100);
  }
  throw lastError || new Error(`Timed out: ${description}`);
}
function execute(win, expression) {
  return win.webContents.executeJavaScript(expression, true);
}
function nativeDrag(from, to) {
  // macOS Quartz 真实鼠标输入，验证 app-region/thickFrame 的原生窗口行为。
  const script = `
import ctypes, sys, time
class CGPoint(ctypes.Structure):
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]
q = ctypes.CDLL('/System/Library/Frameworks/Quartz.framework/Quartz')
q.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, CGPoint, ctypes.c_int]
q.CGEventCreateMouseEvent.restype = ctypes.c_void_p
q.CGEventPost.argtypes = [ctypes.c_int, ctypes.c_void_p]
x1, y1, x2, y2 = map(float, sys.argv[1:])
def post(kind, x, y):
    event = q.CGEventCreateMouseEvent(None, kind, CGPoint(x, y), 0)
    q.CGEventPost(0, event)
post(1, x1, y1)
time.sleep(0.2)
for i in range(1, 16):
    post(5, x1 + (x2-x1)*i/15, y1 + (y2-y1)*i/15)
    time.sleep(0.02)
post(2, x2, y2)
`;
  execFileSync("python3", ["-c", script, String(from.x), String(from.y), String(to.x), String(to.y)], { stdio: "inherit" });
}

function canPostNativeInput() {
  const result = execFileSync("python3", ["-c", "import ctypes; q=ctypes.CDLL('/System/Library/Frameworks/Quartz.framework/Quartz'); q.CGPreflightPostEventAccess.restype=ctypes.c_bool; print('true' if q.CGPreflightPostEventAccess() else 'false')"], { encoding: "utf8" });
  return result.trim() === "true";
}

app.whenReady().then(async () => {
  await import(pathToFileURL(path.join(process.cwd(), "electron/main.js")).href);
  const mainWin = await waitFor(() => BrowserWindow.getAllWindows().find((win) => !win.webContents.getURL().includes("#floating") && !win.isDestroyed()), "main window");
  await waitFor(() => execute(mainWin, "Boolean(document.querySelector('.rail-nav') && window.planPilotNative?.openFloating)"), "main ready");

  const seed = await execute(mainWin, `(() => {
    const now = new Date();
    const date = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    const toTime = minutes => String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
    const start = Math.max(0, now.getHours() * 60 + now.getMinutes() - 30);
    return {
      settings: { workSegments: [{ start: '00:00', end: '23:59' }], breaks: [], timezone: 'auto' },
      ai: { enabled: false }, goals: [],
      tasks: [{ id: 't-float', title: '悬浮窗联动测试任务', date, estimateMinutes: 120, priority: 'high', status: 'open' }],
      blocks: [{ id: 'b-float', taskId: 't-float', title: '', type: 'task', date, start: toTime(start), end: toTime(start + 120), auto: false, done: false }],
      dayPlans: {}, reviews: [], recurring: []
    };
  })()`);
  const originalEnd = seed.blocks[0].end;
  const serialized = JSON.stringify(JSON.stringify(seed));
  await execute(mainWin, `fetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${serialized} }).then(r => r.json())`);
  mainWin.webContents.reload();
  await pause(1000);
  await waitFor(() => execute(mainWin, "JSON.parse(localStorage.getItem('personal-planning-coach-v1') || '{}').tasks?.some(task => task.id === 't-float')"), "seed hydration");
  await execute(mainWin, "window.planPilotNative.openFloating()");

  const floatingWin = await waitFor(() => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes("#floating") && !win.isDestroyed()), "floating window");
  await waitFor(() => execute(floatingWin, "Boolean(document.querySelector('.floating-actions'))"), "floating actions");
  assert.equal(floatingWin.isMovable(), true);
  assert.equal(floatingWin.isResizable(), true);
  const regions = await execute(floatingWin, `({
    root: getComputedStyle(document.querySelector('.floating-root')).getPropertyValue('-webkit-app-region'),
    button: getComputedStyle(document.querySelector('.floating-actions button')).getPropertyValue('-webkit-app-region')
  })`);
  assert.deepEqual(regions, { root: "drag", button: "no-drag" });

  floatingWin.setBounds({ x: 120, y: 120, width: 360, height: 260 });
  const initial = floatingWin.getBounds();
  const brand = await execute(floatingWin, `(() => { const r = document.querySelector('.floating-brand').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  floatingWin.focus();
  const canPost = canPostNativeInput();
  const moved = floatingWin.getBounds();
  if (canPost) {
    nativeDrag(
      { x: initial.x + brand.x, y: initial.y + brand.y },
      { x: initial.x + brand.x + 110, y: initial.y + brand.y + 70 },
    );
    await pause(500);
    const actualMoved = floatingWin.getBounds();
    assert.ok(Math.abs(actualMoved.x - initial.x) >= 60 && Math.abs(actualMoved.y - initial.y) >= 40, `window did not move: ${JSON.stringify({ initial, actualMoved })}`);
    console.log("PASS 原生拖动", { x: initial.x, y: initial.y }, "→", { x: actualMoved.x, y: actualMoved.y });

    nativeDrag(
      { x: actualMoved.x + 357, y: actualMoved.y + 257 },
      { x: actualMoved.x + 457, y: actualMoved.y + 327 },
    );
    await pause(500);
    const actualResized = floatingWin.getBounds();
    assert.ok(actualResized.width >= initial.width + 60 && actualResized.height >= initial.height + 40, `window did not resize: ${JSON.stringify({ initial, actualResized })}`);
    console.log("PASS 原生边缘缩放", `${initial.width}x${initial.height}`, "→", `${actualResized.width}x${actualResized.height}`);
  } else {
    console.log("SKIP 原生鼠标拖拽/边缘缩放：macOS postEventAccess 未授权");
    floatingWin.setBounds({ ...initial, width: 420, height: 300 });
    assert.equal(floatingWin.getBounds().width, 420);
    assert.equal(floatingWin.getBounds().height, 300);
  }

  await execute(floatingWin, "document.querySelector('[aria-label=\"增加 10 分钟\"]').click()");
  await waitFor(() => execute(mainWin, `JSON.parse(localStorage.getItem('personal-planning-coach-v1')).blocks[0].end !== '${originalEnd}'`), "+10 main store");
  const extendedEnd = await execute(mainWin, "JSON.parse(localStorage.getItem('personal-planning-coach-v1')).blocks[0].end");
  assert.equal(await execute(floatingWin, `document.querySelector('.pip-time').textContent.includes('${extendedEnd}')`), true);
  await execute(floatingWin, "document.querySelector('[aria-label=\"减少 10 分钟\"]').click()");
  await waitFor(() => execute(mainWin, `JSON.parse(localStorage.getItem('personal-planning-coach-v1')).blocks[0].end === '${originalEnd}'`), "-10 main store");
  console.log("PASS 加减 10 分钟与主窗同步");

  const image = await floatingWin.webContents.capturePage();
  await fs.writeFile("design/floating-fixed.png", image.toPNG());
  await execute(floatingWin, "document.querySelector('.pip-done').click()");
  await waitFor(() => execute(mainWin, "JSON.parse(localStorage.getItem('personal-planning-coach-v1')).tasks[0].status === 'done'"), "complete main store");
  assert.equal(await execute(mainWin, "JSON.parse(localStorage.getItem('personal-planning-coach-v1')).blocks[0].done"), true);
  console.log("PASS 完成本段与主窗同步");
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
