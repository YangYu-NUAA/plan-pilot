// 全局「App 时区」：默认跟随系统；设置里选定 IANA 时区后，
// appNow() 返回「本地分量 == 目标时区分量」的偏移 Date——
// 全站的 getHours/getMinutes/getLocalDate 经它统一按所选时区运转
// （今天、现在线、当下视图、块前提醒、跨天滚动……）。

let activeTimeZone = null; // null = 跟随系统时区

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function setActiveTimeZone(tz) {
  activeTimeZone = isValidTimeZone(tz) ? tz : null;
}

export function getActiveTimeZone() {
  return activeTimeZone;
}

// 目标时区相对 UTC 的偏移（分钟），含夏令时（按 date 所在时刻判定）
function tzOffsetMinutes(tz, date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = {};
  for (const part of dtf.formatToParts(date)) parts[part.type] = part.value;
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUTC - date.getTime()) / 60000);
}

// 偏移 Date：getHours()/getMinutes()/getSeconds() 直接给出所选时区的时分秒
export function appNow(realNow = new Date()) {
  if (!activeTimeZone) return realNow;
  const localOffset = -realNow.getTimezoneOffset();
  const targetOffset = tzOffsetMinutes(activeTimeZone, realNow);
  return new Date(realNow.getTime() + (targetOffset - localOffset) * 60000);
}
