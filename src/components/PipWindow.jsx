import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, PictureInPicture2, X } from "lucide-react";
import { getLocalDate, toMinutes, toTime } from "../utils/dateTime.js";

// Document Picture-in-Picture 悬浮窗：始终置顶的迷你面板，
// 显示当前/下一个时间块 + 进度 + 完成按钮。Chrome/Edge 支持，
// 不支持的浏览器直接隐藏入口（feature-detect）。
export const pipSupported = typeof window !== "undefined" && "documentPictureInPicture" in window;

function PipContent({ current, next, taskById, onCompleteTask, onClose }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000 * 10);
    return () => clearInterval(timer);
  }, []);

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const block = current || next;
  const task = block?.taskId ? taskById[block.taskId] : null;
  const title = task?.title || block?.title || "";
  const isNow = Boolean(current);

  let progress = 0;
  let remainText = "";
  if (isNow && current) {
    const start = toMinutes(current.start);
    const end = toMinutes(current.end);
    progress = Math.min(1, Math.max(0, (nowMin - start) / Math.max(1, end - start)));
    const remain = Math.max(0, end - nowMin);
    remainText = remain > 0 ? `剩余 ${remain} 分` : "已超时";
  }

  return (
    <div className="pip-root">
      <div className="pip-head">
        <span className={`pip-state${isNow ? " is-now" : ""}`}>{isNow ? "进行中" : "下一个"}</span>
        <button type="button" className="pip-close" onClick={onClose} title="关闭悬浮窗">
          <X size={13} />
        </button>
      </div>
      {block ? (
        <>
          <strong className="pip-title">{title || "未命名块"}</strong>
          <span className="pip-time">{block.start}–{block.end}{remainText ? ` · ${remainText}` : ""}</span>
          <div className="pip-progress">
            <i style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <div className="pip-actions">
            {task && task.status !== "done" && (
              <button type="button" className="pip-done" onClick={() => onCompleteTask(task.id)}>
                <Check size={13} />
                完成
              </button>
            )}
          </div>
        </>
      ) : (
        <span className="pip-empty">今天暂无时间块</span>
      )}
    </div>
  );
}

export function PipWindow({ blocks, taskById, selectedDate, onCompleteTask }) {
  const [pipWin, setPipWin] = useState(null);
  const pipWinRef = useRef(null);

  const closePip = useCallback(() => {
    pipWinRef.current?.close();
    pipWinRef.current = null;
    setPipWin(null);
  }, []);

  async function openPip() {
    if (!pipSupported) return;
    try {
      const win = await window.documentPictureInPicture.requestWindow({ width: 280, height: 148 });
      // 把主文档的样式表复制进 PiP 窗口，保持令牌/主题一致
      for (const sheet of document.styleSheets) {
        try {
          const css = Array.from(sheet.cssRules).map((r) => r.cssText).join("\n");
          const style = win.document.createElement("style");
          style.textContent = css;
          win.document.head.appendChild(style);
        } catch {
          const link = win.document.createElement("link");
          link.rel = "stylesheet";
          link.href = sheet.href;
          win.document.head.appendChild(link);
        }
      }
      // 同步主题
      win.document.documentElement.dataset.theme = document.documentElement.dataset.theme || "";
      win.document.body.style.margin = "0";
      const container = win.document.createElement("div");
      win.document.body.appendChild(container);
      win.addEventListener("pagehide", () => {
        pipWinRef.current = null;
        setPipWin(null);
      });
      pipWinRef.current = win;
      setPipWin({ win, container });
    } catch {
      // 用户取消或浏览器拒绝时静默
    }
  }

  // 主窗口卸载时关掉 PiP
  useEffect(() => () => pipWinRef.current?.close(), []);

  const todayStr = getLocalDate();
  const isToday = selectedDate === todayStr;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const sorted = blocks
    .filter((b) => b.date === selectedDate)
    .slice()
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  const current = isToday ? sorted.find((b) => toMinutes(b.start) <= nowMin && nowMin < toMinutes(b.end)) : null;
  const next = isToday ? sorted.find((b) => toMinutes(b.start) > nowMin) : null;

  if (!pipSupported) return null;

  return (
    <>
      <button
        type="button"
        className="secondary-action pip-launch"
        title="弹出始终置顶的迷你悬浮窗，随时看到当前块"
        onClick={pipWin ? closePip : openPip}
      >
        <PictureInPicture2 size={16} />
        {pipWin ? "收起悬浮窗" : "悬浮窗"}
      </button>
      {pipWin &&
        createPortal(
          <PipContent
            current={current}
            next={next}
            taskById={taskById}
            onCompleteTask={onCompleteTask}
            onClose={closePip}
          />,
          pipWin.container,
        )}
    </>
  );
}
