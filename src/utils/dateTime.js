import { appNow } from "./clock.js";

export function getLocalDate(date = appNow()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(dateString, amount) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + amount);
  return getLocalDate(date);
}

export function formatShortDate(dateString) {
  const [, month, day] = dateString.split("-").map(Number);
  return `${month}月${day}日`;
}

// 把 YYYY-MM-DD 转成中文日期
// 例如："2026-06-23" -> "6月23日星期二"
export function formatHumanDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date(year, month - 1, day));
}

export function toMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

export function toTime(minutes) {
  const hours = `${Math.floor(minutes / 60)}`.padStart(2, "0");
  const mins = `${minutes % 60}`.padStart(2, "0");
  return `${hours}:${mins}`;
}

export function duration(start, end) {
  return Math.max(0, toMinutes(end) - toMinutes(start));
}

// 两个 YYYY-MM-DD 的天数差（b - a），用 UTC 避免夏令时误差
export function dayDiff(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}
