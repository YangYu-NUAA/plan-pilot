// 弱模型 / 推理模型的 JSON 解析加固，纯函数，便于单测。
// 设计取舍：
// - 字符串感知的括号配平：能剥掉模型在 JSON 前后写的解释文字，且不会被字符串值里的杂散括号 / 冒号带偏。
// - 支持对象 {} 与数组 [] 两种根。
// - 只做最克制的清洗（全角双引号→半角、去尾逗号），绝不替换全角逗号/冒号，以免破坏中文正文。

// 从一段文本里按括号配平截出第一段完整 JSON（对象或数组）。未闭合（被截断）时返回到末尾，交给后续尽力解析。
export function sliceBalancedJson(text) {
  const startObj = text.indexOf("{");
  const startArr = text.indexOf("[");
  let start = -1;
  if (startObj >= 0 && (startArr < 0 || startObj < startArr)) start = startObj;
  else if (startArr >= 0) start = startArr;
  if (start < 0) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return text.slice(start);
}

export function extractJson(content) {
  const raw = String(content || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(raw);
  for (const cand of candidates) {
    // 1) 直接解析（纯净 JSON 走这条）
    try { return JSON.parse(cand); } catch {}
    // 2) 括号配平截取（剥掉前后解释文字，支持对象/数组根）
    const sliced = sliceBalancedJson(cand);
    if (!sliced) continue;
    try { return JSON.parse(sliced); } catch {}
    // 3) 轻度清洗后再试：全角双引号→半角、去尾逗号
    const tidy = sliced.replace(/[“”]/g, '"').replace(/,(\s*[}\]])/g, "$1");
    try { return JSON.parse(tidy); } catch {}
  }
  throw new Error("AI 返回内容不是有效 JSON。");
}

export function tryExtractJson(content) {
  try {
    return extractJson(content);
  } catch {
    return null;
  }
}

// 从 open 位置（{ 或 [）开始，按字符串感知配平返回闭合下标；未闭合返回 -1。
function matchBalancedEnd(s, start) {
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 扫描一段文本里【所有顶层配平】的 JSON 对象/数组并逐个解析成功的返回（用于从推理链/夹叙夹议里捞 JSON）。
export function extractJsonObjects(text) {
  const s = String(text || "");
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "{" || ch === "[") {
      const end = matchBalancedEnd(s, i);
      if (end > i) {
        try { out.push(JSON.parse(s.slice(i, end + 1))); } catch { /* 跳过不合法片段 */ }
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

// 「有意义」的结果对象：含规划相关的答案键之一，用来把真正的回复和零碎片段（如 {"type":"add_goal"}）区分开。
const MEANINGFUL_KEYS = [
  "message", "actions", "items", "tasks", "goals", "busy", "busyBlocks",
  "blocks", "questions", "taskAdjustments", "summary", "workStyle",
];
export function isMeaningfulJson(obj) {
  return Boolean(obj) && typeof obj === "object" && !Array.isArray(obj) && MEANINGFUL_KEYS.some((k) => k in obj);
}

// 从可能包含多段 JSON 的文本（典型：推理模型把答案写进 reasoning）里挑出「最像最终答案」的对象：
// 取最后一个含有意义键的对象；没有就取最后一个对象。
export function richestJson(text) {
  const objs = extractJsonObjects(text).filter((o) => o && typeof o === "object" && !Array.isArray(o));
  const meaningful = objs.filter(isMeaningfulJson);
  if (meaningful.length) return meaningful[meaningful.length - 1];
  return objs.length ? objs[objs.length - 1] : null;
}
