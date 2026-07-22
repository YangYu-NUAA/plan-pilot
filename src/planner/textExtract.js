// 从自然语言文本抽取时间、任务与固定安排；含标题时长/日期推断等启发式。
import { uid } from "../utils/ids.js";
import { addDays, toMinutes, toTime } from "../utils/dateTime.js";
import {
  normalizeSentence,
  isBusySentence,
  isMeetingSentence,
  isPostMeetingTask,
  looksLikeSingleActionItem,
  pinnableTimeForTitle,
} from "../planningSemantics.js";
import { normalizeTitle, taskIdentity, titleLooksDuplicate } from "./dedup.js";

export function defaultBusyDuration(sentence) {
  if (/监考|考试/.test(sentence)) return 120;
  if (/火车|高铁|航班|出发|前往|返回|通勤/.test(sentence)) return 120;
  return 60;
}

// 句子分类、抽取闸门、购票时间守卫已移至 ./planningSemantics.js（可被 node --test 独立测试）。

export function parseChineseNumber(value) {
  const text = String(value || "");
  if (/^\d+$/.test(text)) return Number(text);

  const digits = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const tenIndex = text.indexOf("十");
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : digits[text.slice(0, tenIndex)];
    const onesText = text.slice(tenIndex + 1);
    const ones = onesText ? digits[onesText] : 0;
    return Number.isInteger(tens) && Number.isInteger(ones) ? tens * 10 + ones : NaN;
  }

  const parsed = [...text].map((character) => digits[character]);
  return parsed.length && parsed.every(Number.isInteger) ? Number(parsed.join("")) : NaN;
}

export function parseTimeInSentence(sentence) {
  const matches = String(sentence || "").matchAll(
    /(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*([:：.点时])?\s*(半|一刻|三刻)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})?\s*(?:分)?/g,
  );

  for (const match of matches) {
    const marker = match[1] || "";
    const separator = match[3] || "";
    let hour = parseChineseNumber(match[2]);
    let minute = match[5] ? parseChineseNumber(match[5]) : 0;
    if (match[4] === "半") minute = 30;
    if (match[4] === "一刻") minute = 15;
    if (match[4] === "三刻") minute = 45;

    if (!marker && !separator) continue;
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) continue;
    if (/下午|傍晚|晚上/.test(marker) && hour < 12) hour += 12;
    if (marker === "中午" && hour < 11) hour += 12;

    return toTime(hour * 60 + minute);
  }

  return null;
}

// 把"上午/下午/晚上"等模糊时段映射成默认时间窗——仅当句子没有具体钟点时兜底用，
// 让"27号上午去华为"这类带模糊时段的固定事项也能落成时间轴上的块，而不是只当无时间任务。
export const ROUGH_TIME_WINDOWS = [
  ["凌晨", "06:00", "08:00"],
  ["早上", "08:00", "09:30"],
  ["上午", "09:00", "12:00"],
  ["中午", "12:00", "13:00"],
  ["下午", "14:00", "18:00"],
  ["傍晚", "17:00", "19:00"],
  ["晚上", "19:00", "22:00"],
];
export function roughTimeWindow(sentence) {
  const text = String(sentence || "");
  for (const [marker, start, end] of ROUGH_TIME_WINDOWS) {
    if (text.includes(marker)) return { start, end };
  }
  return null;
}

// 去掉事项标题开头的日期/时段/钟点前缀，让标题干净（"27号上午去华为…" → "去华为…"），
// 也避免同一事件因前缀不同（27号/28号）在去重时被当成不同标题。日期/时间已单独解析，不丢信息。
export function cleanEventTitle(sentence) {
  let t = String(sentence || "").trim();
  t = t.replace(/^(今天|明天|后天|大后天|下周[一二三四五六日天]?|本周[一二三四五六日天]?)/, "");
  t = t.replace(/^\s*(\d{1,2}\s*月)?\s*\d{1,2}\s*[日号]/, "");
  t = t.replace(/^\s*(凌晨|早上|上午|中午|下午|傍晚|晚上)/, "");
  t = t.replace(/^\s*\d{1,2}\s*[:：.点时]\s*\d{0,2}\s*分?/, "");
  t = t.trim();
  return t || String(sentence || "").trim();
}

export function extractBusyBlocksFromText(text, date, existingBlocks = []) {
  const existingKeys = new Set(
    existingBlocks
      .filter((block) => block.date === date && block.type === "busy")
      .map((block) => `${block.start}|${normalizeTitle(block.title)}`),
  );

  return String(text || "")
    .split(/[\n。；;]/)
    .map(normalizeSentence)
    .filter((sentence) => sentence && isBusySentence(sentence) && looksLikeSingleActionItem(sentence))
    .map((sentence) => {
      let start = parseTimeInSentence(sentence);
      let end;
      if (start) {
        end = toTime(toMinutes(start) + defaultBusyDuration(sentence));
      } else {
        // 没有具体钟点：用模糊时段（上午/下午…）兜底成一个时间窗块
        const rough = roughTimeWindow(sentence);
        if (!rough) return null;
        start = rough.start;
        end = rough.end;
      }
      return {
        id: uid("block"),
        date,
        type: "busy",
        taskId: "",
        title: cleanEventTitle(sentence),
        start,
        end,
        auto: false,
      };
    })
    .filter(Boolean)
    .filter((block) => {
      const key = `${block.start}|${normalizeTitle(block.title)}`;
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });
}

export function extractCoachBusyItemsFromText(text, selectedDate, existingBlocks = []) {
  const recoveredBlocks = [];

  String(text || "")
    .split(/[\n。；;]/)
    .map(normalizeSentence)
    .filter(Boolean)
    .forEach((sentence) => {
      const date = inferDateFromText(sentence, selectedDate);
      extractBusyBlocksFromText(sentence, date, existingBlocks.concat(recoveredBlocks)).forEach((block) => {
        recoveredBlocks.push(block);
      });
    });

  return recoveredBlocks.map((block) => ({
    kind: "busy",
    title: block.title,
    date: block.date,
    start: block.start,
    end: block.end,
  }));
}

export function toBusyBlocks(items) {
  return items.map((item) => ({
    id: uid("block"),
    date: item.date,
    type: "busy",
    taskId: "",
    title: item.title,
    start: item.start,
    end: item.end,
    auto: false,
  }));
}

export function recoverBusyBlocksFromPlanningContext(text, selectedDate, existingBlocks = []) {
  return toBusyBlocks(extractCoachBusyItemsFromText(text, selectedDate, existingBlocks));
}

export function mergeUniqueBusyBlocks(existingBlocks, recoveredBlocks) {
  const merged = [...existingBlocks];

  recoveredBlocks.forEach((candidate) => {
    const duplicate = merged.some(
      (block) =>
        block.type === "busy" &&
        block.date === candidate.date &&
        block.start === candidate.start &&
        titleLooksDuplicate(block.title, candidate.title),
    );
    if (!duplicate) merged.push(candidate);
  });

  return merged;
}

export function extractTimedTasksFromText(text, date, existingTasks = []) {
  const existingKeys = new Set(existingTasks.map(taskIdentity));

  return String(text || "")
    .split(/[\n。；;]/)
    .map(normalizeSentence)
    .filter((sentence) => sentence && isMeetingSentence(sentence) && parseTimeInSentence(sentence))
    .map((sentence) => ({
      id: uid("task"),
      title: cleanEventTitle(sentence),
      estimateMinutes: defaultBusyDuration(sentence),
      priority: "high",
      goalId: "",
      date,
      status: "open",
      fixedTime: true,
      createdAt: new Date().toISOString(),
    }))
    .filter((task) => {
      const key = taskIdentity(task);
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });
}

export function isMorningActionSentence(sentence) {
  if (!sentence) return false;
  if (isMeetingSentence(sentence) && parseTimeInSentence(sentence)) return false;
  if (isBusySentence(sentence) && parseTimeInSentence(sentence)) return false;
  if (isPostMeetingTask(sentence)) return true;
  if (/会议|开会|课题会|组会|例会|研讨会|监考|考试|上课|答辩|面试/.test(sentence)) return false;
  if (/购买|买票|订票|预订|查票|抢票|打印|复印|扫描|提交|发送|完成|修改|撰写|整理|准备|确认|联系|回复|阅读|调研|查看|检查|申请|下载|上传|填写/.test(sentence)) {
    return true;
  }
  return false;
}

export function extractActionTasksFromText(text, date, existingTasks = []) {
  const existingKeys = new Set(existingTasks.map(taskIdentity));

  return String(text || "")
    .split(/[\n。；;]/)
    .map(normalizeSentence)
    .filter((sentence) => isMorningActionSentence(sentence) && looksLikeSingleActionItem(sentence))
    .map((sentence) => {
      // 动作型句子若带明确时钟时间，视为「固定时间任务」，排期时钉到该时间点；否则为浮动任务，填充空档。
      // 购票任务除外：标题里的时间是车次/出发时间，不能据此钉定执行时间（pinnableTimeForTitle 会返回空）。
      const start = pinnableTimeForTitle(sentence, parseTimeInSentence(sentence));
      return {
        id: uid("task"),
        title: cleanEventTitle(sentence),
        estimateMinutes: estimateMinutesForTitle(sentence, 45),
        priority: start ? "high" : "medium",
        goalId: "",
        date,
        status: "open",
        ...(start ? { fixedTime: true, fixedStart: start } : {}),
        createdAt: new Date().toISOString(),
      };
    })
    .filter((task) => {
      const key = taskIdentity(task);
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });
}


export function estimateMinutesForTitle(title, fallback = 45) {
  const text = String(title || "");
  let estimate = Number(fallback) || 45;

  if (/整理|总结|纪要|复盘|行动项|后续|待办|要点/.test(text) && /会|会议|讨论|探讨|汇报|组会|研讨/.test(text)) {
    return Math.min(Math.max(estimate, 60), 90);
  }
  if (/初步设计|框架设计|方案设计|课题设计|研究设计|系统设计|方法设计|技术路线|整体方案|架构设计/.test(text)) {
    estimate = Math.max(estimate, 180);
  }
  if (/研究|论文|基金|申请|课题|项目|产品|系统|平台|课程|报告/.test(text) && /设计|方案|框架|定义|目标/.test(text)) {
    estimate = Math.max(estimate, 180);
  }
  if (/撰写|写作|修改|整合|相关工作|文献|调研/.test(text)) {
    estimate = Math.max(estimate, 120);
  }
  if (/会议|开会|课题会|组会|研讨会|汇报|会谈/.test(text)) {
    estimate = Math.max(estimate, 60);
  }
  if (/打印|复印|扫描/.test(text)) {
    estimate = Math.min(Math.max(estimate, 15), 30);
  }
  if (/购买|买票|订票|查票|回复|发送/.test(text)) {
    estimate = Math.min(Math.max(estimate, 10), 30);
  }

  return estimate;
}

export function nextWeekday(dateString, targetDay) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const current = date.getDay();
  let delta = (targetDay - current + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(dateString, delta);
}

// 把"日号"（1-31）解析到不早于 fromDate 的下一次出现：本月该日 < 今天则顺延下月；超过当月天数取月末。
export function nextDateWithDay(fromDate, day) {
  if (!(day >= 1 && day <= 31)) return null;
  const [y, m, d] = fromDate.split("-").map(Number);
  let year = y;
  let month = m;
  if (day < d) {
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  const dim = new Date(year, month, 0).getDate(); // 该月实际天数
  const dd = Math.min(day, dim);
  return `${year}-${String(month).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// 把"M月N日"解析到不早于 fromDate 的那一年（今年若已过则取明年）。
export function nextDateWithMonthDay(fromDate, month, day) {
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  const build = (yr) =>
    `${yr}-${String(month).padStart(2, "0")}-${String(Math.min(day, new Date(yr, month, 0).getDate())).padStart(2, "0")}`;
  let year = Number(fromDate.split("-")[0]);
  if (build(year) < fromDate) year += 1;
  return build(year);
}

export function inferDateFromText(value, selectedDate) {
  const text = String(value || "").toLowerCase();
  const absolute = text.match(/\d{4}-\d{2}-\d{2}/);
  if (absolute) return absolute[0];
  if (/明天|tomorrow/.test(text)) return addDays(selectedDate, 1);
  if (/后天/.test(text)) return addDays(selectedDate, 2);
  if (/下周一|next monday/.test(text)) return nextWeekday(selectedDate, 1);
  if (/下周二|next tuesday/.test(text)) return nextWeekday(selectedDate, 2);
  if (/下周三|next wednesday/.test(text)) return nextWeekday(selectedDate, 3);
  if (/下周四|next thursday/.test(text)) return nextWeekday(selectedDate, 4);
  if (/下周五|next friday/.test(text)) return nextWeekday(selectedDate, 5);
  if (/下周六|next saturday/.test(text)) return nextWeekday(selectedDate, 6);
  if (/下周日|下周天|next sunday/.test(text)) return nextWeekday(selectedDate, 0);
  if (/下周|next week/.test(text)) return nextWeekday(selectedDate, 1);
  // "M月N日 / M月N号"
  const md = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (md) {
    const dt = nextDateWithMonthDay(selectedDate, Number(md[1]), Number(md[2]));
    if (dt) return dt;
  }
  // "N号 / N日"（无月份，取下一次该日号；如"27号"）
  const dom = text.match(/(\d{1,2})\s*[日号]/);
  if (dom) {
    const dt = nextDateWithDay(selectedDate, Number(dom[1]));
    if (dt) return dt;
  }
  return selectedDate;
}
