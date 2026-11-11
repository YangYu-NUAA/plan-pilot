import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { parseCommandInput } from "../utils/commandParse.js";
import { VoiceButton } from "./ui/VoiceButton.jsx";

// OmniBar 常驻输入栏：首页的统一入口。
// 本地能看懂的（有日期/时间/命令信号，或短任务名）→ 立即执行；
// 看不懂的长句 → 自动转给 AI 访谈。语音与文字同一条管道。
export function OmniBar({
  onExecute,
  onAiChat,
  onStartInterview,
  coachScope = "today",
  onScopeChange,
  selectedDate,
  todayStr,
  voiceEngine = "stepfun",
  voiceApiKey = "",
  voiceBaseUrl = "",
  voiceModel = "",
  voiceAutoSend = true,
}) {
  const [input, setInput] = useState("");
  const [note, setNote] = useState(""); // 瞬时反馈（如「已转给 AI 访谈」）
  const [voiceError, setVoiceError] = useState("");
  const [voiceState, setVoiceState] = useState("idle"); // 录音/识别状态文字提示
  const inputRef = useRef(null);
  const baseRef = useRef(""); // 录音开始时输入框已有内容
  const noteTimer = useRef(null);
  const inputIntents = parseCommandInput(input, { selectedDate, todayStr });
  const nextIntent = inputIntents.find((intent) => !intent.weak);

  useEffect(() => () => clearTimeout(noteTimer.current), []);

  function flashNote(text) {
    setNote(text);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(""), 2600);
  }

  function forwardToAi(value) {
    onAiChat(value);
    setInput("");
    flashNote("这句交给 AI 访谈处理了 ↘");
  }

  // 明确指令（含日期/时间/时长或命令词）本地执行；弱输入交给 AI。
  // 输入栏下方同步展示回车结果，✨ 永远是显式的 AI 入口。
  function submit(text) {
    const value = String(text || "").trim();
    if (!value) return;
    const intents = parseCommandInput(value, { selectedDate, todayStr });
    const strong = intents.find((intent) => !intent.weak);
    if (strong) {
      onExecute(strong);
      setInput("");
      flashNote(strong.label);
      return;
    }
    forwardToAi(value);
  }

  return (
    <div className="omnibar-wrap">
      <div className="omnibar">
        <VoiceButton
          engine={voiceEngine}
          apiKey={voiceApiKey}
          baseUrl={voiceBaseUrl}
          model={voiceModel}
          hint="语音输入"
          onStart={() => { baseRef.current = input.trim() ? `${input.trim()} ` : ""; setVoiceError(""); }}
          onError={setVoiceError}
          onStateChange={setVoiceState}
          onInterim={(text) => setInput(baseRef.current + text)}
          onText={(text) => {
            const full = baseRef.current + text;
            baseRef.current = "";
            if (voiceAutoSend) submit(full);
            else {
              setInput(full);
              inputRef.current?.focus();
            }
          }}
        />
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit(input);
            else if (e.key === "Escape") setInput("");
          }}
          placeholder="写周报 30分钟 / 明天下午3点组会 / 其他想法交给 AI"
          aria-label="全能输入栏"
        />
        {onScopeChange && (
          <select
            className="omnibar-scope"
            value={coachScope}
            onChange={(e) => onScopeChange(e.target.value)}
            aria-label="访谈范围"
            title="AI 访谈范围"
          >
            <option value="today">今天</option>
            <option value="week">本周</option>
            <option value="month">月度</option>
            <option value="long">长期</option>
          </select>
        )}
        {input.trim() && (
          <button
            type="button"
            className="omnibar-send"
            title="发送（Enter）"
            aria-label="发送"
            onClick={() => submit(input)}
          >
            ↵
          </button>
        )}
        <button
          type="button"
          className="omnibar-ai"
          title={input.trim() ? "交给 AI 访谈处理" : "开始访谈——AI 主动提问引导你规划"}
          aria-label={input.trim() ? "交给 AI 处理" : "开始访谈"}
          onClick={() => {
            const value = input.trim();
            if (value) forwardToAi(value);
            else onStartInterview?.();
          }}
        >
          <Sparkles size={15} />
        </button>
      </div>
      {input.trim() && (
        <div className="omnibar-hint" role="status">
          {nextIntent ? `↵ ${nextIntent.label} · ✨ 交给 AI` : "↵ 交给 AI 访谈，不会直接创建任务"}
        </div>
      )}
      {voiceState === "recording" && <div className="omnibar-status is-live">正在录音——说完再点一次麦克风结束</div>}
      {voiceState === "transcribing" && <div className="omnibar-status">识别中…</div>}
      {note && <div className="omnibar-note">{note}</div>}
      {voiceError && (
        <div className="voice-inline-error omnibar-voice-error" role="alert">
          {voiceError}
          <button type="button" aria-label="关闭错误提示" onClick={() => setVoiceError("")}>×</button>
        </div>
      )}
    </div>
  );
}
