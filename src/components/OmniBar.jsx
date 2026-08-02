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

  // 统一入口：本地能懂 → 执行；不懂 → 转 AI
  function submit(text) {
    const value = String(text || "").trim();
    if (!value) return;
    const intents = parseCommandInput(value, { selectedDate, todayStr });
    // 明确信号：时间块 / 跳日期 / 命令类 → 直接执行
    const strong = intents.find((i) => i.kind !== "add-task");
    if (strong) {
      onExecute(strong);
      setInput("");
      return;
    }
    // 短句按任务处理（「写周报」「回复邮件」）；长句没信号更像对 AI 说的话
    if (value.length <= 16 && intents.length > 0) {
      onExecute(intents[0]);
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
          placeholder="说话或打字：明天下午3点组会 / 写周报 30分钟 / 周五 …看不懂的自动转给 AI"
          aria-label="全能输入栏"
        />
        <button
          type="button"
          className="omnibar-ai"
          title="直接交给 AI 访谈处理"
          aria-label="交给 AI 处理"
          onClick={() => {
            const value = input.trim();
            if (value) forwardToAi(value);
          }}
        >
          <Sparkles size={15} />
        </button>
        <kbd>↵</kbd>
      </div>
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
