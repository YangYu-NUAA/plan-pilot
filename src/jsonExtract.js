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
