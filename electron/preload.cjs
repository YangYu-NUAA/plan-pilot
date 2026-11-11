// CommonJS（sandbox 渲染器的 preload 只支持 require，不接受包内 "type":"module" 的 ESM）
const { contextBridge, ipcRenderer } = require("electron");

// 最小暴露面：原生悬浮窗 + 系统安全存储；Key 的加解密只在主进程执行。
contextBridge.exposeInMainWorld("planPilotNative", {
  openFloating: () => ipcRenderer.send("pp:open-floating"),
  credentials: Object.freeze({
    status: () => ipcRenderer.invoke("pp:secure-storage-status"),
    get: (key) => ipcRenderer.invoke("pp:secure-storage-get", key),
    set: (key, value) => ipcRenderer.invoke("pp:secure-storage-set", key, value),
  }),
});
