// CommonJS（sandbox 渲染器的 preload 只支持 require，不接受包内 "type":"module" 的 ESM）
const { contextBridge, ipcRenderer } = require("electron");

// 最小暴露面：打开/聚焦原生迷你悬浮窗（Document PiP 在 Electron 不可用）。
contextBridge.exposeInMainWorld("planPilotNative", {
  openFloating: () => ipcRenderer.send("pp:open-floating"),
});
