import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { FloatingApp } from "./views/FloatingApp.jsx";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import "@fontsource-variable/inter";
import "./styles.css";

// #floating：Electron 原生迷你悬浮窗的只读入口，跳过整个主应用
const isFloating = window.location.hash.startsWith("#floating");

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isFloating ? <FloatingApp /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);

// Service Worker 只服务浏览器 PWA；Electron 原生壳禁用并清理存量注册
// （SW 缓存旧 assets 会造成「更新不生效」的幽灵问题）
const isElectronShell = navigator.userAgent.includes("Electron");
if (isElectronShell) {
  navigator.serviceWorker?.getRegistrations?.().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
} else if (!isFloating && "serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service Worker registration failed:", err);
    });
  });
}
