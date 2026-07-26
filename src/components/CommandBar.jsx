import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  Clock,
  Command as CommandIcon,
  ListChecks,
  Palette,
  Play,
  Plus,
  Settings as SettingsIcon,
  Target,
} from "lucide-react";
import { parseCommandInput } from "../utils/commandParse.js";

const KIND_ICON = {
  "add-task": Plus,
  "add-block": Clock,
  "goto-date": CalendarDays,
  focus: Play,
  view: ListChecks,
  theme: Palette,
  settings: SettingsIcon,
};
const VIEW_ICON = { today: CalendarDays, goals: Target, review: ListChecks };

// ⌘K 全局命令条：所有解析都是本地的（commandParse），零网络、零延迟。
export function CommandBar({ open, onClose, onExecute, selectedDate, todayStr, defaults = [] }) {
  const [input, setInput] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const intents = useMemo(
    () => (input.trim() ? parseCommandInput(input, { selectedDate, todayStr }) : defaults),
    [input, selectedDate, todayStr, defaults],
  );

  useEffect(() => {
    if (open) {
      setInput("");
      setActiveIdx(0);
      // 等动画起一帧再聚焦，避免移动端键盘抖动
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setActiveIdx(0), [input]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIdx((i) => (intents.length ? (i + 1) % intents.length : 0));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIdx((i) => (intents.length ? (i - 1 + intents.length) % intents.length : 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        const intent = intents[activeIdx];
        if (intent) {
          onExecute(intent);
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, intents, activeIdx, onClose, onExecute]);

  // 激活项滚进可视区
  useEffect(() => {
    listRef.current?.children[activeIdx]?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  if (!open) return null;

  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div className="cmdk" role="dialog" aria-label="命令条" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input-row">
          <CommandIcon size={16} aria-hidden />
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="试试：明天下午3点到4点 组会 / 写周报 30分钟 / 周五 / 专注 / 主题"
            aria-label="命令输入"
          />
          <kbd>esc</kbd>
        </div>
        {intents.length > 0 ? (
          <ul className="cmdk-list" ref={listRef} role="listbox">
            {intents.map((intent, idx) => {
              const Icon = intent.kind === "view" ? VIEW_ICON[intent.view] || ListChecks : KIND_ICON[intent.kind] || Plus;
              return (
                <li key={`${intent.kind}-${idx}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={idx === activeIdx}
                    className={`cmdk-item${idx === activeIdx ? " active" : ""}`}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => {
                      onExecute(intent);
                      onClose();
                    }}
                  >
                    <span className="cmdk-item-icon">
                      <Icon size={15} aria-hidden />
                    </span>
                    <span className="cmdk-item-label">{intent.label}</span>
                    {intent.hint && <span className="cmdk-item-hint">{intent.hint}</span>}
                    {idx === activeIdx && <kbd>↵</kbd>}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          input.trim() && <p className="cmdk-empty">没看懂这句话。试试「明天下午3点 组会」或「写周报 30分钟」。</p>
        )}
        <div className="cmdk-foot">
          <span>
            <kbd>↑↓</kbd> 选择
          </span>
          <span>
            <kbd>↵</kbd> 执行
          </span>
          <span className="cmdk-foot-note">纯本地解析 · 不经过大模型</span>
        </div>
      </div>
    </div>
  );
}
