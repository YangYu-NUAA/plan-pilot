import { useState } from "react";

// 语音识别（ASR）独立 Key：与聊天 Key 分家——两边经常是不同服务商/模型。
// 同样只存浏览器 localStorage，不落服务器数据文件。
export const VOICE_KEY_STORAGE_KEY = "plan-pilot-voice-key-v1";

function readLocalVoiceKey() {
  try {
    return localStorage.getItem(VOICE_KEY_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function useLocalVoiceKey() {
  const [voiceKey, setVoiceKey] = useState(readLocalVoiceKey);

  function updateVoiceKey(value) {
    setVoiceKey(value);
    try {
      if (value) {
        localStorage.setItem(VOICE_KEY_STORAGE_KEY, value);
      } else {
        localStorage.removeItem(VOICE_KEY_STORAGE_KEY);
      }
    } catch (error) {
      console.error("Voice key localStorage write failed:", error);
    }
  }

  return [voiceKey, updateVoiceKey];
}
