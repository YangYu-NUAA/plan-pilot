import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { isNative } from "../app/platform.js";

// 打卡/完成的触觉反馈：原生壳走系统震动，Web 端静默跳过。
export function tapDone() {
  if (!isNative) return;
  Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});
}

export function tapLight() {
  if (!isNative) return;
  Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
}

export function tapSuccess() {
  if (!isNative) return;
  Haptics.notification({ type: NotificationType.Success }).catch(() => {});
}
