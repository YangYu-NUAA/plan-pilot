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
export function VoiceButton({ engine = "stepfun", apiKey = "", baseUrl = "", model = "", onText, onInterim, onStart, onError, onStateChange, disabled = false, hint = "语音输入" }) {
  const [state, setStateRaw] = useState("idle"); // idle | recording | transcribing | error
  const setState = (next) => { // 同步外抛状态，父组件可展示「录音中/识别中」文字
    setStateRaw(next);
    onStateChange?.(next);
  };
  const [error, setError] = useState("");
  const recorderRef = useRef(null);
  const recognizerRef = useRef(null);
  const busyRef = useRef(false); // 启动/停止竞态锁：state 闭包在快速连点时可能读到旧值
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
    if (onError) {
      // 父组件接管错误展示（内联错误条），按钮只短暂变色提示
      onError(message);
      setState("error");
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => setState("idle"), 1600);
      return;
    }
    setError(message);
    setState("error");
    clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => {
      setState("idle");
      setError("");
    }, 3200);
  }

  async function start() {
    if (busyRef.current) return;
    busyRef.current = true;
    setError("");
    onStart?.();
    if (engine === "browser") {
      const recognizer = createBrowserRecognizer({
        onInterim: (text) => onInterim?.(text),
        onText: (text) => onText?.(text),
        onError: (code) => {
          busyRef.current = false;
          flashError(code === "not-allowed" ? "麦克风权限被拒绝了" : "浏览器识别出错了");
        },
      });
      if (!recognizer) {
        busyRef.current = false;
        return flashError("当前浏览器不支持语音识别，换阶跃 ASR 试试");
      }
      recognizerRef.current = recognizer;
      try {
        recognizer.start();
        setState("recording");
      } catch {
        busyRef.current = false;
        flashError("无法启动浏览器识别");
      }
      return;
    }
    // 阶跃 ASR：先录后转
    if (!navigator.mediaDevices?.getUserMedia) {
      // 局域网 http://IP 访问不是安全上下文，浏览器会禁用麦克风（iOS Safari/Chrome 均如此）
      flashError("当前环境禁用麦克风：用 localhost 打开，或部署/隧道成 HTTPS 后访问");
      busyRef.current = false;
      return;
    }
    const recorder = createMicRecorder();
    recorderRef.current = recorder;
    try {
      await recorder.start();
      setState("recording");
      // 最长 90 秒自动停止
      maxTimerRef.current = setTimeout(() => stop(), 90_000);
    } catch (e) {
      busyRef.current = false;
      flashError(e?.name === "NotAllowedError" ? "麦克风权限被拒绝了" : "打不开麦克风");
    }
  }

  async function stop() {
    clearTimeout(maxTimerRef.current);
    if (engine === "browser") {
      recognizerRef.current?.stop(); // onend 里回传最终文本
      busyRef.current = false;
      setState("idle");
      return;
    }
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) {
      busyRef.current = false;
      return;
    }
    setState("transcribing");
    try {
      const raw = await recorder.stop();
      if (!raw || raw.size < 1000) throw new Error("太短了，按住多说一句");
      const wav = await blobToWav(raw);
      const text = await transcribeAudio(wav, { apiKey, baseUrl, model });
      onText?.(text);
      setState("idle");
    } catch (e) {
      flashError(e?.message || "识别失败，再试一次");
    } finally {
      busyRef.current = false;
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
      {state === "error" && !onError && error && <span className="voice-error">{error}</span>}
    </span>
  );
}
