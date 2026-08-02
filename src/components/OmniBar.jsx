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

  // 统一入口：只有强结构化指令（含时间/日期的安排、跳日期、命令）直接执行；
  // 其余一律交给 AI 访谈——OmniBar 替代的是完整访谈的输入入口，
  // 随手一句话不该不经过对话就变成任务。
  function submit(text) {
    const value = String(text || "").trim();
    if (!value) return;
    const intents = parseCommandInput(value, { selectedDate, todayStr });
    const strong = intents.find((i) => i.kind !== "add-task");
    if (strong) {
      onExecute(strong);
      setInput("");
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
          placeholder="和 AI 说任何事：帮我规划本周 / 明天下午3点有组会（含时间的安排会自动排入时间轴）"
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
        <kbd>↵</kbd>
      </div>
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
