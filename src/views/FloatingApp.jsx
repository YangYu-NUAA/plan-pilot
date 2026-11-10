import { useEffect, useMemo, useState } from "react";
import { appNow } from "../utils/clock.js";import { X } from "lucide-react";
import { getLocalDate, toMinutes } from "../utils/dateTime.js";

// Electron 原生迷你悬浮窗（#floating 入口）：只读展示当前/下一个时间块。
// 独立 BrowserWindow 与主窗同源——数据走 /api/data 轮询（30s）+ 每秒倒计时；
// 不做打卡等写操作，避免与主窗全量 POST 互相覆盖。
export function FloatingApp() {
  const [now, setNow] = useState(() => appNow());
  const [data, setData] = useState(null);

  useEffect(() => {
    const tick = setInterval(() => setNow(appNow()), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch("/api/data")
        .then((r) => r.json())
        .then((d) => { if (alive && d && !d.error) setData(d); })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  // 与主窗同源：localStorage 共享，读同一份主题令牌
  useEffect(() => {
    try {
      const theme = localStorage.getItem("plan-pilot-theme");
      if (theme) document.documentElement.dataset.theme = theme;
    } catch { /* ignore */ }
  }, []);

  const todayStr = getLocalDate();
  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

  const { current, next, tasks } = useMemo(() => {
    const blocks = (data?.blocks || [])
      .filter((b) => b.date === todayStr)
      .slice()
      .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    return {
      current: blocks.find((b) => toMinutes(b.start) <= nowMin && nowMin < toMinutes(b.end)) || null,
      next: blocks.find((b) => toMinutes(b.start) > nowMin) || null,
      tasks: data?.tasks || [],
    };
  }, [data, todayStr, nowMin]);

  const block = current || next;
  const taskById = useMemo(() => Object.fromEntries(tasks.map((t) => [t.id, t])), [tasks]);
  const task = block?.taskId ? taskById[block.taskId] : null;
  const title = task?.title || block?.title || "";
  const isNow = Boolean(current);

  let progress = 0;
  let remainText = "";
  if (isNow && current) {
    const start = toMinutes(current.start);
    const end = toMinutes(current.end);
    progress = Math.min(1, Math.max(0, (nowMin - start) / Math.max(1, end - start)));
    const remain = Math.max(0, Math.round(end - nowMin));
    remainText = remain > 0 ? `剩余 ${remain} 分` : "已超时";
  } else if (block) {
    const lead = Math.max(0, Math.round(toMinutes(block.start) - nowMin));
    remainText = lead > 0 ? `${lead} 分钟后开始` : "";
  }

  return (
    <div className="pip-root floating-root">
      <div className="pip-head floating-drag">
        <span className={`pip-state${isNow ? " is-now" : ""}`}>{isNow ? "进行中" : "下一个"}</span>
        <span className="floating-brand">Plan Pilot</span>
        <button type="button" className="pip-close" onClick={() => window.close()} title="关闭">
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
        </>
      ) : (
        <span className="pip-empty">今天暂无时间块 · 打卡请回主窗</span>
      )}
    </div>
  );
}
