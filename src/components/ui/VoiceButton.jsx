import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import {
  blobToWav,
  browserSpeechSupported,
  createBrowserRecognizer,
  createMicRecorder,
  transcribeAudio,
} from "../../utils/voiceInput.js";

// 通用语音输入按钮：点一下开始、再点停止；识别文字经 onText 回调（浏览器引擎
// 另有 onInterim 流式中间结果）。确认缓冲由父组件负责——文字先落输入框，用户过目后再提交。
export function VoiceButton({ engine = "stepfun", apiKey = "", onText, onInterim, onStart, disabled = false, hint = "语音输入" }) {
  const [state, setState] = useState("idle"); // idle | recording | transcribing | error
  const [error, setError] = useState("");
  const recorderRef = useRef(null);
  const recognizerRef = useRef(null);
  const maxTimerRef = useRef(null);
  const errorTimerRef = useRef(null);

  useEffect(() => () => {
    clearTimeout(maxTimerRef.current);
    clearTimeout(errorTimerRef.current);
    recorderRef.current?.cancel();
    recognizerRef.current?.cancel();
  }, []);

  const unsupported = engine === "browser" && !browserSpeechSupported();

  function flashError(message) {
    setError(message);
    setState("error");
    clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => {
      setState("idle");
      setError("");
    }, 3200);
  }

  async function start() {
    setError("");
    onStart?.();
    if (engine === "browser") {
      const recognizer = createBrowserRecognizer({
        onInterim: (text) => onInterim?.(text),
        onText: (text) => onText?.(text),
        onError: (code) => flashError(code === "not-allowed" ? "麦克风权限被拒绝了" : "浏览器识别出错了"),
      });
      if (!recognizer) return flashError("当前浏览器不支持语音识别，换阶跃 ASR 试试");
      recognizerRef.current = recognizer;
      try {
        recognizer.start();
        setState("recording");
      } catch {
        flashError("无法启动浏览器识别");
      }
      return;
    }
    // 阶跃 ASR：先录后转
    const recorder = createMicRecorder();
    recorderRef.current = recorder;
    try {
      await recorder.start();
      setState("recording");
      // 最长 90 秒自动停止
      maxTimerRef.current = setTimeout(() => stop(), 90_000);
    } catch (e) {
      flashError(e?.name === "NotAllowedError" ? "麦克风权限被拒绝了" : "打不开麦克风");
    }
  }

  async function stop() {
    clearTimeout(maxTimerRef.current);
    if (engine === "browser") {
      recognizerRef.current?.stop(); // onend 里回传最终文本
      setState("idle");
      return;
    }
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) return;
    setState("transcribing");
    try {
      const raw = await recorder.stop();
      if (!raw || raw.size < 1000) throw new Error("太短了，按住多说一句");
      const wav = await blobToWav(raw);
      const text = await transcribeAudio(wav, { apiKey });
      onText?.(text);
      setState("idle");
    } catch (e) {
      flashError(e?.message || "识别失败，再试一次");
    }
  }

  function toggle() {
    if (state === "recording") stop();
    else if (state === "idle" || state === "error") start();
  }

  return (
    <span className="voice-btn-wrap">
      <button
        type="button"
        className={`voice-btn is-${state}`}
        onClick={toggle}
        disabled={disabled || unsupported || state === "transcribing"}
        title={unsupported ? "当前浏览器不支持语音识别，请在设置里改用阶跃 ASR" : state === "recording" ? "说完点这里停止" : hint}
        aria-label={state === "recording" ? "停止录音" : hint}
      >
        {state === "transcribing" ? (
          <Loader2 size={16} className="voice-spin" />
        ) : state === "recording" ? (
          <Square size={13} />
        ) : (
          <Mic size={16} />
        )}
        {state === "recording" && (
          <span className="voice-bars" aria-hidden>
            <i /><i /><i />
          </span>
        )}
      </button>
      {state === "error" && error && <span className="voice-error">{error}</span>}
    </span>
  );
}
