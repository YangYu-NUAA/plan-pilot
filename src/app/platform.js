import { Capacitor, CapacitorHttp } from "@capacitor/core";

// 平台能力探测：原生壳（Capacitor）里不走本机服务器，
// 数据纯 localStorage，AI 用原生 HTTP 直连（绕过 WebView CORS）。
export const isNative = Boolean(Capacitor?.isNativePlatform?.());
export const isElectron =
  typeof window !== "undefined" &&
  (Boolean(window.planPilotNative) ||
    (typeof navigator !== "undefined" && navigator.userAgent.includes("Electron")));
// Android 无本地服务；Electron 与 Web 都有 /api/data，但服务生命周期和排查方式不同。
export const hasLocalServer = !isNative;

export { CapacitorHttp };
