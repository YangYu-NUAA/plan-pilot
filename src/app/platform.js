import { Capacitor, CapacitorHttp } from "@capacitor/core";

// 平台能力探测：原生壳（Capacitor）里不走本机服务器，
// 数据纯 localStorage，AI 用原生 HTTP 直连（绕过 WebView CORS）。
export const isNative = Boolean(Capacitor?.isNativePlatform?.());
export const hasLocalServer = !isNative;

export { CapacitorHttp };
