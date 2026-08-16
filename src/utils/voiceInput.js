import { isNative, CapacitorHttp } from "../app/platform.js";

// 语音输入双引擎：
//  - "stepfun"：MediaRecorder 录音 → 解码重编码为 16kHz 单声道 WAV →
//    经 /api/asr 代理转发阶跃 ASR（api.stepfun.com/v1/audio/transcriptions，
//    模型 stepaudio-2.5-asr）。音频不经过第三方，API Key 不落前端。
//  - "browser"：Web Speech API（SpeechRecognition），零成本、支持流式中间结果；
//    但 Chrome 实现会把音频发往浏览器厂商服务器，所以在设置里由用户显式选择。

export const VOICE_ENGINES = { stepfun: "阶跃 ASR", browser: "浏览器识别" };

export function browserSpeechSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// —— 录音 ——
export function createMicRecorder() {
  let recorder = null;
  let chunks = [];
  let stream = null;

  return {
    async start() {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/mp4",
      ].find((m) => MediaRecorder.isTypeSupported(m));
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data?.size) chunks.push(e.data);
      };
      recorder.start(250);
    },
    async stop() {
      return new Promise((resolve) => {
        if (!recorder) return resolve(null);
        recorder.onstop = () => {
          stream?.getTracks().forEach((t) => t.stop());
          resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
        };
        recorder.stop();
      });
    },
    cancel() {
      try {
        recorder?.stop();
      } catch { /* ignore */ }
      stream?.getTracks().forEach((t) => t.stop());
      recorder = null;
      chunks = [];
    },
  };
}

// —— 重编码：任意浏览器录音格式 → 16kHz 单声道 16bit WAV（阶跃 ASR 支持 wav） ——
export async function blobToWav(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000;
    const samples = downmixResample(buf, rate);
    return new Blob([encodeWav(samples, rate)], { type: "audio/wav" });
  } finally {
    ctx.close?.();
  }
}

function downmixResample(buf, targetRate) {
  const left = buf.getChannelData(0);
  const right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const ratio = buf.sampleRate / targetRate;
  const outLen = Math.max(1, Math.round(buf.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const idx = Math.min(buf.length - 1, Math.round(i * ratio));
    out[i] = right ? (left[idx] + right[idx]) / 2 : left[idx];
  }
  return out;
}

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM 块大小
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

// —— 阶跃 ASR（经本地服务器代理） ——
export async function transcribeAudio(wavBlob, { apiKey, baseUrl, model } = {}) {
  // 原生壳：无代理，Step Plan 路径走 SSE JSON 直连（其他路径需桌面/服务器模式）
  if (isNative) {
    if (!/step_plan/i.test(String(baseUrl || ""))) {
      throw new Error("原生直连暂支持 Step Plan 语音识别路径，请在设置里把 ASR 地址填为 https://api.stepfun.com/step_plan/v1");
    }
    return transcribeStepPlanDirect(wavBlob, { apiKey, baseUrl, model });
  }
  const res = await fetch("/api/asr", {
    method: "POST",
    headers: {
      "Content-Type": "audio/wav",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
      ...(baseUrl ? { "x-asr-base-url": baseUrl } : {}),
      ...(model ? { "x-asr-model": model } : {}),
    },
    body: wavBlob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || `语音识别失败（${res.status}）`;
    throw new Error(typeof msg === "string" ? msg : "语音识别失败");
  }
  const text = String(data.text || "").trim();
  if (!text) throw new Error("没听清，靠近一点再说一次？");
  return text;
}

// —— 原生直连：Step Plan SSE（JSON + base64 PCM，与服务器代理同一协议） ——
async function transcribeStepPlanDirect(wavBlob, { apiKey, baseUrl, model } = {}) {
  const buf = await wavBlob.arrayBuffer();
  const pcm = buf.byteLength > 44 ? buf.slice(44) : buf; // 剥 WAV 头取 pcm_s16le
  const base64 = arrayBufferToBase64(pcm);
  const url = `${String(baseUrl).replace(/\/+$/, "")}/audio/asr/sse`;
  const response = await CapacitorHttp.post({
    url,
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    data: {
      audio: {
        data: base64,
        input: {
          transcription: { model: model || "stepaudio-2.5-asr", language: "zh", enable_itn: true },
          format: { type: "pcm", codec: "pcm_s16le", rate: 16000, bits: 16, channel: 1 },
        },
      },
    },
    connectTimeout: 30_000,
    readTimeout: 90_000,
  });
  if (response.status < 200 || response.status >= 300) {
    const msg = response.data?.error?.message || response.data?.message || `语音识别失败（${response.status}）`;
    throw new Error(typeof msg === "string" ? msg : "语音识别失败");
  }
  const raw = typeof response.data === "string" ? response.data : JSON.stringify(response.data || "");
  let finalText = "";
  let deltas = "";
  let errMsg = "";
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const evt = JSON.parse(payload);
      if (evt.type === "transcript.text.done") finalText = evt.text || finalText;
      else if (evt.type === "transcript.text.delta") deltas += evt.delta || "";
      else if (evt.type === "error") errMsg = evt.message || "未知错误";
    } catch { /* 忽略心跳/注释行 */ }
  }
  if (errMsg) throw new Error(`上游 ASR 错误：${errMsg}`);
  const text = (finalText || deltas).trim();
  if (!text) throw new Error("没听清，靠近一点再说一次？");
  return text;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// —— 浏览器识别引擎：流式中间结果 ——
export function createBrowserRecognizer({ onInterim, onText, onError }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = "zh-CN";
  rec.continuous = true;
  rec.interimResults = true;
  let finalized = "";
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      const transcript = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalized += transcript;
      else interim += transcript;
    }
    onInterim?.(finalized + interim);
  };
  rec.onerror = (e) => {
    if (e.error !== "aborted") onError?.(e.error);
  };
  rec.onend = () => {
    const text = finalized.trim();
    if (text) onText?.(text);
  };
  return {
    start() {
      finalized = "";
      rec.start();
    },
    stop() {
      rec.stop();
    },
    cancel() {
      finalized = "";
      rec.abort();
    },
  };
}
