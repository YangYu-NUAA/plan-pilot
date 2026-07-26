import { addDays, toTime } from "./dateTime.js";
import { estimateMinutesForTitle, nextWeekday, nextDateWithDay } from "../planner/textExtract.js";

// —— Cmd+K 命令条纯本地解析：不经过任何大模型 ——
// 输入一句话，产出可执行意图（intent）列表，组件负责展示、App 负责执行。
// intent.kind:
//   add-task   { date, title, estimateMinutes }
//   add-block  { date, title, start, end, blockType: "busy"|"task" }
//   goto-date  { date }
//   focus      {}           专注当前/下一个时间块
//   view       { view }     today | goals | review
//   theme      { theme? }   无 theme 时循环切换
//   settings   {}

const THEMES = ["warm", "cool", "graphite", "night"];
const THEME_NAMES = { warm: "暖象牙", cool: "冷蓝", graphite: "墨灰", night: "暗夜" };

const DAY_NAMES = "日一二三四五六";
const WEEKDAY_MAP = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

// 固定安排（busy）关键词：出现即把带时间的条目建为「不可用时间」而非任务块
const BUSY_PATTERN = /会议|组会|开会|上课|听课|通勤|接送|健身|跑步|游泳|午饭|晚饭|吃饭|午休|午睡|监考|门诊|看牙|理发|值班|聚餐|约会|接孩子|飞机|高铁|火车/;

function pad2(n) {
  return String(n).padStart(2, "0");
}

export function formatCnDate(dateStr, todayStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const weekday = DAY_NAMES[new Date(y, m - 1, d).getDay()];
  const base = `${m}月${d}日·周${weekday}`;
  if (dateStr === todayStr) return `今天（${base}）`;
  if (dateStr === addDays(todayStr, 1)) return `明天（${base}）`;
  if (dateStr === addDays(todayStr, 2)) return `后天（${base}）`;
  return base;
}

// 本周内的周X：今天以后的最近一次（含今天）；下周X 用 nextWeekday（严格下周）
function thisWeekday(dateStr, targetDay) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const cur = new Date(y, m - 1, d).getDay();
  return addDays(dateStr, (targetDay - cur + 7) % 7);
}

// 从文本中抽取日期，返回 { date, rest }；没提到日期时 date 为 null
function extractDate(text, selectedDate) {
  let m;
  if ((m = text.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日号]?/))) {
    return { date: `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`, rest: text.replace(m[0], " ") };
  }
  if (/(大后天)/.test(text)) return { date: addDays(selectedDate, 3), rest: text.replace(/大后天/, " ") };
  if (/(后天)/.test(text)) return { date: addDays(selectedDate, 2), rest: text.replace(/后天/, " ") };
  if (/(明天|tomorrow)/i.test(text)) return { date: addDays(selectedDate, 1), rest: text.replace(/明天|tomorrow/i, " ") };
  if (/(今天|今日)/.test(text)) return { date: selectedDate, rest: text.replace(/今天|今日/, " ") };
  if ((m = text.match(/下周([一二三四五六日天])/))) {
    return { date: nextWeekday(selectedDate, WEEKDAY_MAP[m[1]]), rest: text.replace(m[0], " ") };
  }
  if ((m = text.match(/(?:周|星期)([一二三四五六日天])/))) {
    return { date: thisWeekday(selectedDate, WEEKDAY_MAP[m[1]]), rest: text.replace(m[0], " ") };
  }
  if ((m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/))) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const [y] = selectedDate.split("-").map(Number);
      let date = `${y}-${pad2(month)}-${pad2(day)}`;
      if (date < selectedDate) date = `${y + 1}-${pad2(month)}-${pad2(day)}`;
      return { date, rest: text.replace(m[0], " ") };
    }
  }
  if ((m = text.match(/(\d{1,2})\s*[-/](\d{1,2})(?!\d)/))) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const [y] = selectedDate.split("-").map(Number);
      let date = `${y}-${pad2(month)}-${pad2(day)}`;
      if (date < selectedDate) date = `${y + 1}-${pad2(month)}-${pad2(day)}`;
      return { date, rest: text.replace(m[0], " ") };
    }
  }
  if ((m = text.match(/(\d{1,2})\s*[日号]/))) {
    const dt = nextDateWithDay(selectedDate, Number(m[1]));
    if (dt) return { date: dt, rest: text.replace(m[0], " ") };
  }
  return { date: null, rest: text };
}

// 从文本中抽取时间范围/时间点。返回 { start, end, rest }（分钟数可能被调至 24h 制）
function extractTime(text) {
  const pmContext = /(下午|晚上|傍晚|午间|中午)/.test(text);
  const toHHMM = (h, min) => {
    let hour = Number(h);
    if (pmContext && hour < 12) hour += 12;
    if (hour > 23 || Number(min || 0) > 59) return null;
    return `${pad2(hour)}:${pad2(min || 0)}`;
  };
  let m;
  // 15:00-16:00 / 15:00到16:00
  if ((m = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})\s*(?:-|–|—|~|到|至)\s*(\d{1,2})\s*[:：]\s*(\d{2})/))) {
    const start = toHHMM(m[1], m[2]);
    const end = toHHMM(m[3], m[4]);
    if (start && end) return { start, end, rest: text.replace(m[0], " ") };
  }
  // 下午3点到4点 / 3点-4点半
  if ((m = text.match(/(\d{1,2})\s*点(\d{1,2}|半)?分?\s*(?:-|–|—|~|到|至)\s*(\d{1,2})\s*点(\d{1,2}|半)?分?/))) {
    const minOf = (v) => (v === "半" ? 30 : Number(v) || 0);
    const start = toHHMM(m[1], minOf(m[2]));
    const end = toHHMM(m[3], minOf(m[4]));
    if (start && end) return { start, end, rest: text.replace(m[0], " ") };
  }
  // 单个时间点：15:00 / 下午3点 / 3点半
  if ((m = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})/))) {
    const start = toHHMM(m[1], m[2]);
    if (start) return { start, end: null, rest: text.replace(m[0], " ") };
  }
  if ((m = text.match(/(\d{1,2})\s*点(半|(\d{1,2})\s*分?)?/))) {
    const min = m[2] === "半" ? 30 : Number(m[3]) || 0;
    const start = toHHMM(m[1], min);
    if (start) return { start, end: null, rest: text.replace(m[0], " ") };
  }
  return { start: null, end: null, rest: text };
}

// 抽取时长（分钟），返回 { minutes, rest }
function extractDuration(text) {
  let m;
  if ((m = text.match(/(\d+)\s*(?:分钟|min|m\b)/i))) {
    return { minutes: Number(m[1]), rest: text.replace(m[0], " ") };
  }
  if ((m = text.match(/(\d+(?:\.\d+)?)\s*(?:个?小时|h\b)/i))) {
    return { minutes: Math.round(Number(m[1]) * 60), rest: text.replace(m[0], " ") };
  }
  if (/半小时/.test(text)) return { minutes: 30, rest: text.replace(/半小时/, " ") };
  if (/一小时/.test(text)) return { minutes: 60, rest: text.replace(/一小时/, " ") };
  return { minutes: null, rest: text };
}

function cleanTitle(text) {
  return text
    .replace(/^(在|于|把|将|我要|我想|帮我|添加|新建|创建|安排|排|做|去)+/, "")
    .replace(/[，,。.\s]+$/, "")
    .replace(/^[，,。.\s]+/, "")
    .trim();
}

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function parseCommandInput(raw, { selectedDate, todayStr }) {
  const input = String(raw || "").trim();
  if (!input) return [];

  // —— 纯命令 ——
  if (/^(专注|focus)$/i.test(input)) {
    return [{ kind: "focus", label: "进入专注模式", hint: "当前 / 下一个时间块" }];
  }
  if (/^(复盘|review)$/i.test(input)) return [{ kind: "view", view: "review", label: "打开复盘视图", hint: "" }];
  if (/^(目标|goals?)$/i.test(input)) return [{ kind: "view", view: "goals", label: "打开目标视图", hint: "" }];
  if (/^(设置|settings?)$/i.test(input)) return [{ kind: "settings", label: "打开设置", hint: "" }];
  const themeMatch = input.match(/^(主题|theme)\s*(.*)$/i);
  if (themeMatch) {
    const name = themeMatch[2];
    const hit = Object.entries(THEME_NAMES).find(([, cn]) => cn === name) ||
      Object.entries(THEME_NAMES).find(([en]) => en === name.toLowerCase());
    return [
      hit
        ? { kind: "theme", theme: hit[0], label: `切换到「${hit[1]}」主题`, hint: "" }
        : { kind: "theme", theme: null, label: "切换主题（循环）", hint: "暖象牙 → 冷蓝 → 墨灰 → 暗夜" },
    ];
  }

  // —— 自然语言：日期 + 时间 + 时长 + 标题 ——
  const d = extractDate(input, selectedDate);
  const t = extractTime(d.rest);
  // 时段词（上午/下午…）只用于 24h 制换算，不应留在标题里
  const dur = extractDuration(t.rest.replace(/凌晨|早上|上午|中午|午间|下午|傍晚|晚上/g, " "));
  const title = cleanTitle(dur.rest);
  const date = d.date || selectedDate;

  // 只写了日期：跳转
  if (!title && d.date && !t.start) {
    return [{ kind: "goto-date", date: d.date, label: `跳到${formatCnDate(d.date, todayStr)}`, hint: "" }];
  }
  if (!title) return [];

  const intents = [];
  const dateLabel = formatCnDate(date, todayStr);

  if (t.start) {
    // 有时间点/段：优先建块
    const start = t.start;
    let end = t.end;
    if (!end) {
      const length = dur.minutes || estimateMinutesForTitle(title, 60);
      end = toTime(Math.min(24 * 60, minutesOf(start) + length));
    }
    if (minutesOf(end) > minutesOf(start)) {
      const blockType = BUSY_PATTERN.test(title) ? "busy" : "task";
      intents.push({
        kind: "add-block",
        date, title, start, end, blockType,
        label: `排入时间轴「${title}」`,
        hint: `${dateLabel} ${start}–${end} · ${blockType === "busy" ? "固定安排" : "任务时间块"}`,
      });
    }
  }
  // 总是提供「仅添加任务」的退路
  const estimateMinutes = dur.minutes || estimateMinutesForTitle(title, 30);
  intents.push({
    kind: "add-task",
    date, title, estimateMinutes,
    label: `添加任务「${title}」`,
    hint: `${dateLabel} · 约 ${estimateMinutes} 分钟`,
  });
  return intents;
}

export { THEMES, THEME_NAMES };
