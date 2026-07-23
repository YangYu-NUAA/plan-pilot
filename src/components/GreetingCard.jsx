import { useEffect, useState } from "react";
import { Compass, X } from "lucide-react";
import { addDays, getLocalDate } from "../utils/dateTime.js";
import { priorityOrder } from "../constants/labels.js";
import { callPlanningAi } from "../ai/callPlanningAi.js";

const STORE_KEY = "plan-pilot-greeting";

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
  } catch {
    return {};
  }
}

// 无 AI 时的本地模板：也能给出有具体指向的问候
function localGreeting({ todayTasks, todayBlocks, yesterdayDone, yesterdayTotal }) {
  const open = todayTasks.filter((t) => t.status !== "done");
  const top = open.slice().sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority])[0];
  const parts = [];
  if (yesterdayTotal > 0) {
    parts.push(`昨天完成了 ${yesterdayDone}/${yesterdayTotal} 个任务`);
  }
  if (todayBlocks.length > 0) {
    parts.push(`今天排了 ${todayBlocks.length} 个时间块`);
  } else {
    parts.push("今天还没有排时间块");
  }
  if (top) {
    parts.push(`最高优先级是「${top.title}」，从它开始`);
  }
  return parts.length ? `早安。${parts.join("，")}。` : "早安。今天想推进什么？从写下一件事开始。";
}

async function aiGreeting({ ai, apiKey, serverKeyOk, context }) {
  const result = await callPlanningAi({
    ai,
    apiKey,
    serverKeyOk,
    json: false,
    maxTokens: 300,
    messages: [
      {
        role: "system",
        content:
          "你是用户的私人规划助手。根据给出的昨日完成情况与今日安排，写一句简短、温暖、有具体指向的中文早安问候" +
          "（60 字以内），要点出今天最值得先做的事。不要客套套话，不要列表，直接给一句问候。",
      },
      { role: "user", content: context },
    ],
  });
  const text = String(result?.content || result?.message || "").trim();
  return text.slice(0, 120);
}

// 主动式 AI 问候：每天首次打开出现一次，结果缓存当天；
// 无 API Key 时用本地模板；可关闭当天卡片或永久静音。
export function GreetingCard({ planner, todayTasks, todayBlocks, ai, apiKey, serverKeyOk }) {
  const [greeting, setGreeting] = useState(null); // null=不显示
  const todayStr = getLocalDate();

  useEffect(() => {
    const store = loadStore();
    if (store.muted) return;
    if (store.date === todayStr && store.text) {
      // 今天已生成过：若用户已手动关闭（shown）则不重复弹出
      if (!store.shown) setGreeting(store.text);
      return;
    }
    // 数据可能尚未从服务端水合：暂无任务且无块时等下一轮数据到达再生成
    if (planner.tasks.length === 0 && todayBlocks.length === 0 && planner.goals.length === 0) return;
    const yesterday = addDays(todayStr, -1);
    const yesterdayTasks = planner.tasks.filter((t) => t.date === yesterday);
    const payload = {
      todayTasks,
      todayBlocks,
      yesterdayDone: yesterdayTasks.filter((t) => t.status === "done").length,
      yesterdayTotal: yesterdayTasks.length,
    };
    const fallback = localGreeting(payload);

    // 无 Key 直接用本地模板；有 Key 尝试 AI 生成，失败回落本地模板
    if (!apiKey && !serverKeyOk) {
      setGreeting(fallback);
      localStorage.setItem(STORE_KEY, JSON.stringify({ date: todayStr, text: fallback }));
      return;
    }
    const top = payload.todayTasks
      .filter((t) => t.status !== "done")
      .sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority])[0];
    const context =
      `昨日完成 ${payload.yesterdayDone}/${payload.yesterdayTotal} 个任务。` +
      `今日已排 ${todayBlocks.length} 个时间块（${todayBlocks
        .slice(0, 4)
        .map((b) => `${b.start} ${b.title || "任务"}`)
        .join("；")}）。` +
      (top ? `今日最高优先级任务：「${top.title}」（约 ${top.estimateMinutes} 分钟）。` : "今日暂无待办。");
    setGreeting(fallback); // 先展示本地模板，AI 返回后替换
    aiGreeting({ ai, apiKey, serverKeyOk, context })
      .then((text) => {
        const finalText = text || fallback;
        setGreeting(finalText);
        localStorage.setItem(STORE_KEY, JSON.stringify({ date: todayStr, text: finalText }));
      })
      .catch(() => {
        localStorage.setItem(STORE_KEY, JSON.stringify({ date: todayStr, text: fallback }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayStr, planner.tasks.length, todayBlocks.length]);

  if (!greeting) return null;

  function dismiss() {
    setGreeting(null);
    const store = loadStore();
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...store, date: todayStr, text: store.text || greeting, shown: true }));
  }
  function mute() {
    setGreeting(null);
    localStorage.setItem(STORE_KEY, JSON.stringify({ muted: true }));
  }

  return (
    <aside className="greet-card" role="status">
      <span className="greet-icon"><Compass size={17} /></span>
      <div className="greet-body">
        <p>{greeting}</p>
      </div>
      <div className="greet-actions">
        <button type="button" className="greet-mute" onClick={mute} title="不再显示每日问候">不再显示</button>
        <button type="button" className="greet-dismiss" onClick={dismiss} title="关闭" aria-label="关闭问候">
          <X size={15} />
        </button>
      </div>
    </aside>
  );
}
