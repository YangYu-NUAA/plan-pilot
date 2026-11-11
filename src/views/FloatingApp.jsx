import { useEffect, useMemo, useState } from "react";
import { AlarmClock, Check, Minus, Plus, X } from "lucide-react";
import { getLocalDate, toMinutes } from "../utils/dateTime.js";
import { appNow, setActiveTimeZone } from "../utils/clock.js";
import { adjustBlockDuration, isTaskSessionDone, setTaskSessionDone } from "../planner/taskSessions.js";

// Electron 原生迷你窗（#floating）：两种形态。
//  - 常览：当前/下一个时间块 + 进度 + 完成/加减时长（/api/data 轮询校准）
//  - 专注：主窗发起的迷你番茄钟——状态经同源 localStorage 'plan-pilot-focus' 同步，
//    两种形态的操作都携带 blockId，经 'plan-pilot-focus-cmd' 由主窗统一写入。
const FOCUS_KEY = "plan-pilot-focus";
const FOCUS_CMD_KEY = "plan-pilot-focus-cmd";

function readFocus() {
  try {
    const raw = localStorage.getItem(FOCUS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function sendCmd(type, blockId) {
  localStorage.setItem(FOCUS_CMD_KEY, JSON.stringify({ type, blockId, nonce: Date.now() + Math.random() }));
}

function FloatingActions({ block, task, onAction }) {
  if (!block || !task || isTaskSessionDone(block, task)) return null;
  return (
    <div className="floating-actions" role="group" aria-label="当前时间块操作">
      <button type="button" className="pip-done" onClick={() => onAction("complete", block)}>
        <Check size={13} /> 完成本段
      </button>
      <button type="button" className="pip-extend" aria-label="减少 10 分钟" title="减少 10 分钟（最短保留 15 分钟）" onClick={() => onAction("shorten", block)}>
        <Minus size={13} /> 10 分钟
      </button>
      <button type="button" className="pip-extend" aria-label="增加 10 分钟" title="增加 10 分钟" onClick={() => onAction("extend", block)}>
        <Plus size={13} /> 10 分钟
      </button>
    </div>
  );
}

export function FloatingApp() {
  const [now, setNow] = useState(() => appNow());
  const [data, setData] = useState(null);
  const [focus, setFocus] = useState(readFocus);

  // 首帧时区就位：planner 状态在 localStorage（同源共享），同步读取设置，
  // 不等 /api/data 异步返回——否则首屏用系统时区渲染，「现在」错位
  useEffect(() => {
    try {
      const tz = JSON.parse(localStorage.getItem("personal-planning-coach-v1") || "{}")?.settings?.timezone;
      setActiveTimeZone(tz && tz !== "auto" ? tz : null);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const tick = setInterval(() => setNow(appNow()), 500);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch("/api/data")
        .then((r) => r.json())
        .then((d) => {
          if (!alive || !d || d.error) return;
          setData(d);
          // 与主窗一致：App 时区生效（迷你窗的「现在」与主窗同钟）
          const tz = d.settings?.timezone;
          setActiveTimeZone(tz && tz !== "auto" ? tz : null);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  // 主题 + 专注状态同步（主窗写 FOCUS_KEY 时本窗收到 storage 事件）
  useEffect(() => {
    try {
      const theme = localStorage.getItem("plan-pilot-theme");
      if (theme) document.documentElement.dataset.theme = theme;
    } catch { /* ignore */ }
    const onStorage = (e) => {
      if (e.key === FOCUS_KEY) setFocus(readFocus());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const todayStr = getLocalDate();
  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

  const { current, next, tasks, blocks } = useMemo(() => {
    const all = (data?.blocks || []).slice().sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    const todays = all.filter((b) => b.date === todayStr);
    return {
      current: todays.find((b) => toMinutes(b.start) <= nowMin && nowMin < toMinutes(b.end)) || null,
      next: todays.find((b) => toMinutes(b.start) > nowMin) || null,
      tasks: data?.tasks || [],
      blocks: all,
    };
  }, [data, todayStr, nowMin]);

  const taskById = useMemo(() => Object.fromEntries(tasks.map((t) => [t.id, t])), [tasks]);

  function runAction(type, block) {
    sendCmd(type, block.id);
    // 主窗仍是唯一持久化写方；小窗同步做乐观更新，不必等 30s 轮询才看到结果。
    setData((currentData) => {
      if (!currentData) return currentData;
      if (type === "extend" || type === "shorten") {
        return {
          ...currentData,
          blocks: currentData.blocks.map((item) => item.id === block.id ? adjustBlockDuration(item, type === "extend" ? 10 : -10) : item),
        };
      }
      if (type === "complete") {
        return { ...currentData, ...setTaskSessionDone(currentData.tasks, currentData.blocks, block.id, true) };
      }
      return currentData;
    });
  }

  // —— 专注模式：迷你番茄钟 ——
  const focusBlock = focus ? blocks.find((b) => b.id === focus.blockId) : null;
  // 残留清理：块已删/跨天陈旧（结束超 2 小时且任务已完成）→ 忽略，回常览
  const focusStale = useMemo(() => {
    if (!focusBlock || !focus) return false;
    const end = toMinutes(focusBlock.end);
    const dateOk = focusBlock.date === todayStr;
    const task = focusBlock.taskId ? taskById[focusBlock.taskId] : null;
    return !dateOk || (nowMin - end > 120 && task?.status === "done");
  }, [focusBlock, focus, todayStr, nowMin, taskById]);
  if (focus && focusBlock && !focusStale) {
    const focusTask = focusBlock.taskId ? taskById[focusBlock.taskId] : null;
    const title = focusTask?.title || focusBlock.title || "专注";
    const start = toMinutes(focusBlock.start);
    const end = toMinutes(focusBlock.end);
    const leadMin = start - nowMin; // >0：块还没开始
    const remainSec = Math.round((end - nowMin) * 60);
    const mm = String(Math.floor(Math.max(0, remainSec) / 60)).padStart(2, "0");
    const ss = String(Math.max(0, remainSec) % 60).padStart(2, "0");
    const progress = Math.min(1, Math.max(0, (nowMin - start) / Math.max(1, end - start)));

    return (
      <div className="pip-root floating-root floating-focus">
        <div className="pip-head floating-drag">
          <span className="pip-state is-now"><AlarmClock size={11} /> 专注中</span>
          <span className="floating-brand">
            {leadMin > 0 ? `${Math.max(1, Math.round(leadMin))} 分钟后开始` : `${focusBlock.start}–${focusBlock.end}`}
          </span>
          <button type="button" className="pip-close" onClick={() => sendCmd("exit", focusBlock.id)} title="退出专注（小窗回到常览）">
            <X size={13} />
          </button>
        </div>
        <strong className="pip-title">{title}</strong>
        <div className={`floating-clock${remainSec < 0 ? " is-overtime" : ""}`}>
          {remainSec < 0 ? "+" : ""}{mm}:{ss}
        </div>
        <div className="pip-progress">
          <i style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <FloatingActions block={focusBlock} task={focusTask} onAction={runAction} />
      </div>
    );
  }

  // —— 常览模式：当前/下一个时间块 ——
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
          <FloatingActions block={block} task={task} onAction={runAction} />
        </>
      ) : (
        <span className="pip-empty">今天暂无时间块</span>
      )}
    </div>
  );
}
