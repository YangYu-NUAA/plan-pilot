import { usePersistentKey } from "./usePersistentKey.js";

// 语音识别（ASR）独立 Key：与聊天 Key 分家——两边经常是不同服务商/模型。
// Web/Android 存 localStorage；Electron 由系统安全存储加密，不落服务器数据文件。
export const VOICE_KEY_STORAGE_KEY = "plan-pilot-voice-key-v1";

export function useLocalVoiceKey() {
  return usePersistentKey({ storageKey: VOICE_KEY_STORAGE_KEY, nativeKey: "voice" });
}
