import { app, BrowserWindow, Menu, session, shell } from "electron";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApiHandler } from "../server/dataProxy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 统一 userData：开发（electron .，读 package.json name）与打包（读 productName）
// 的默认目录名不一致，这里显式规范成同一个，保证数据目录稳定。
const USER_DATA_DIR = path.join(app.getPath("appData"), "Plan Pilot");
app.setPath("userData", USER_DATA_DIR);

// 数据目录：默认应用专属目录，环境变量可覆盖（开发调试用）
const DATA_DIR = process.env.PLAN_PILOT_DATA_DIR || path.join(USER_DATA_DIR, "data");
// Web 静态资源：main.js 位于 electron/ 下——开发时是项目 dist/，打包后是 asar 内 dist/，相对路径一致
const DIST_DIR = process.env.PLAN_PILOT_DIST_DIR || path.join(__dirname, "..", "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

const apiHandler = createApiHandler({ dataDir: DATA_DIR });

function startLocalServer() {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);

    if (pathname.startsWith("/api/")) {
      return apiHandler(req, res, () => {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Not found." }));
      });
    }

    // 静态文件（SPA：未命中的无扩展名路径回落 index.html）
    let rel = pathname === "/" ? "/index.html" : pathname;
    let file = path.normalize(path.join(DIST_DIR, rel));
    if (!file.startsWith(path.normalize(DIST_DIR))) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(DIST_DIR, "index.html");
    }
    const ext = path.extname(file).toLowerCase();
    res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", ext === ".html" ? "no-cache" : "public, max-age=604800");
    fs.createReadStream(file)
      .on("error", () => {
        res.statusCode = 404;
        res.end("Not found");
      })
      .pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function createWindow(port) {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    title: "Plan Pilot",
    backgroundColor: "#f3f1ea",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.loadURL(`http://127.0.0.1:${port}/`);

  // 站外链接交给系统浏览器，不在壳内跳走
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function buildMenu() {
  const template = [
    {
      label: "Plan Pilot",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "显示",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "forceReload", label: "强制重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
    {
      role: "window",
      submenu: [{ role: "minimize", label: "最小化" }, { role: "zoom", label: "缩放" }, { role: "close", label: "关闭" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  // 麦克风：语音输入需要 media 权限（127.0.0.1 是安全上下文，授权后 getUserMedia 可用）
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media");
  });

  buildMenu();
  const port = await startLocalServer();
  console.log(`[plan-pilot] local server on http://127.0.0.1:${port} | data: ${DATA_DIR}`);
  createWindow(port);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
