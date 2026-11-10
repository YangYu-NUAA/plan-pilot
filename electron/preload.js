import { contextBridge, ipcRenderer } from "electron";

// 最小暴露面：只给 Web 层一个「打开原生迷你悬浮窗」的通道。
// Document Picture-in-Picture 在 Electron 不可用，悬浮窗由主进程
// 用第二个 BrowserWindow（置顶小窗，#floating 入口）实现。
contextBridge.exposeInMainWorld("planPilotNative", {
  openFloating: () => ipcRenderer.send("pp:open-floating"),
});
