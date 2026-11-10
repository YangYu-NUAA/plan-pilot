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

if (!isFloating && "serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service Worker registration failed:", err);
    });
  });
}
