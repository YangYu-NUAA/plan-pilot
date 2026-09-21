import { useEffect, useRef, useState } from "react";
import { CornerDownLeft, Wand2 } from "lucide-react";
import { parseCommandInput } from "../utils/commandParse.js";
import { VoiceButton } from "./ui/VoiceButton.jsx";

// 首页常驻输入栏：⌘K 命令条的常驻形态。文字/语音同一个入口——
// 强意图（带日期/时间/时长信号、命令词）本地解析直接执行；
// 弱输入（解析不了的裸文本）自动转给 AI 访谈，不静默建任务。
export function OmniBar({
  selectedDate,
  todayStr,
  onCommand,
  onAskAi,
  voiceEngine = "stepfun",
  voiceApiKey = "",
  voiceBaseUrl = "",
  voiceModel = "",
  voiceAutoSend = true,
}) {
  const [input, setInput] = useState("");
  const [note, setNote] = useState("");
  const [noteTone, setNoteTone] = useState("ok");
  const inputRef = useRef(null);
  const voiceBaseRef = useRef("");
  const noteTimerRef = useRef(null);

  useEffect(() => () => clearTimeout(noteTimerRef.current), []);

  function flashNote(text, tone = "ok") {
    setNote(text);
    setNoteTone(tone);
    clearTimeout(noteTimerRef.current);
    noteTimerRef.current = setTimeout(() => setNote(""), 2800);
  }

  // 返回 true = 已处理（执行或转 AI），false = 空输入
  function handle(rawText) {
    const text = String(rawText || "").trim();
    if (!text) return false;
    const intents = parseCommandInput(text, { selectedDate, todayStr });
    const strong = intents.filter((intent) => !intent.weak);
    if (strong.length > 0) {
      onCommand(strong[0]);
      flashNote(`已执行：${strong[0].label}`);
    } else {
      // 约定：解析不了的不静默建任务，转给 AI 访谈
      onAskAi(text);
      flashNote(`已转给 AI 访谈：「${text.length > 18 ? `${text.slice(0, 18)}…` : text}」`, "ai");
    }
    return true;
  }

  function onSubmit(event) {
    event.preventDefault();
    if (handle(input)) setInput("");
  }

  return (
    <div className="omnibar-wrap">
      <form className="omnibar" onSubmit={onSubmit}>
        <Wand2 size={16} className="omnibar-icon" aria-hidden />
        <input
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="说话或打字：明天下午3点组会 / 写周报 30分钟 / 周五 —— 其余的直接问 AI"
          aria-label="全能输入框"
        />
        <VoiceButton
          engine={voiceEngine}
          apiKey={voiceApiKey}
          baseUrl={voiceBaseUrl}
          model={voiceModel}
          hint="语音输入"
          onStart={() => { voiceBaseRef.current = input.trim() ? `${input.trim()} ` : ""; }}
          onInterim={(text) => setInput(voiceBaseRef.current + text)}
          onText={(text) => {
            const full = voiceBaseRef.current + text;
            voiceBaseRef.current = "";
            if (voiceAutoSend) {
              if (handle(full)) setInput("");
            } else {
              setInput(full);
            }
            inputRef.current?.focus();
          }}
        />
        <kbd className="omnibar-kbd"><CornerDownLeft size={12} /></kbd>
      </form>
      {note && <div className={`omnibar-note ${noteTone === "ai" ? "is-ai" : ""}`}>{note}</div>}
    </div>
  );
}
