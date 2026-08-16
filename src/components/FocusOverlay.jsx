import { useEffect, useMemo, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { KeepAwake } from "@capacitor-community/keep-awake";
import { toMinutes } from "../utils/dateTime.js";
import { isNative } from "../app/platform.js";
import { tapSuccess } from "../utils/hapticsFx.js";

// 专注模式：点任务块/任务上的 ▶ 进入。全屏覆盖层，大倒计时圆环，
// 完成即把任务标为 done 并退出。纯本地 state，不引入新数据结构。
export function FocusOverlay({ task, block, goalTitle, onComplete, onExtend, onExit }) {
  const startMin = toMinutes(block.start);
  const endMin = toMinutes(block.end);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 原生壳：专注期间屏幕常亮，退出恢复
  useEffect(() => {
    if (!isNative) return undefined;
    KeepAwake.keepAwake().catch(() => {});
    return () => { KeepAwake.allowSleep().catch(() => {}); };
  }, []);

  // Esc 退出
  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape") onExit();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);

  const { remainSec, progress, overtime } = useMemo(() => {
    const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    const total = Math.max(1, endMin - startMin);
    const remain = endMin - nowMin;
    return {
      remainSec: Math.max(0, Math.round(remain * 60)),
      progress: Math.min(1, Math.max(0, (nowMin - startMin) / total)),
      overtime: remain < 0,
    };
  }, [now, startMin, endMin]);

  const mm = String(Math.floor(remainSec / 60)).padStart(2, "0");
  const ss = String(remainSec % 60).padStart(2, "0");

  // 圆环参数（SVG）
  const R = 120;
  const C = 2 * Math.PI * R;

  return (
    <div className="focus-overlay" role="dialog" aria-modal="true" aria-label="专注模式">
      <button type="button" className="focus-exit" onClick={onExit} title="退出专注（Esc）">
        <X size={20} />
      </button>

      <div className="focus-content">
        <p className="focus-goal">{goalTitle || "自由任务"}</p>
        <h2 className="focus-title">{task.title}</h2>

        <div className={`focus-ring${overtime ? " is-overtime" : ""}`}>
          <svg viewBox="0 0 260 260" width="260" height="260" aria-hidden="true">
            <circle className="focus-ring-track" cx="130" cy="130" r={R} fill="none" strokeWidth="10" />
            <circle
              className="focus-ring-bar"
              cx="130" cy="130" r={R} fill="none" strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - progress)}
              transform="rotate(-90 130 130)"
            />
          </svg>
          <div className="focus-clock">
            <strong>{overtime ? "加时中" : `${mm}:${ss}`}</strong>
            <span>{block.start}–{block.end}</span>
          </div>
        </div>

        <div className="focus-actions">
          <button type="button" className="focus-done" onClick={() => { tapSuccess(); onComplete(); }}>
            <Check size={20} />
            完成
          </button>
          <button type="button" className="focus-extend" onClick={() => onExtend(10)}>
            <Plus size={16} />
            +10 分钟
          </button>
        </div>
      </div>
    </div>
  );
}
