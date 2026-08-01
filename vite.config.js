import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";

const DATA_DIR = path.resolve("data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const INDEX_FILE = path.join(DATA_DIR, ".index.json");
const DAILY_DIR = path.join(DATA_DIR, "daily");
const GOALS_MONTHLY_DIR = path.join(DATA_DIR, "goals", "monthly");
const GOALS_LONGTERM_DIR = path.join(DATA_DIR, "goals", "longterm");
const RECURRING_FILE = path.join(DATA_DIR, "recurring.json");
const PROFILE_FILE = path.join(DATA_DIR, "user-profile.json");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (e) {
    console.warn("readJson: failed to parse", filePath, e.message || e); // from PR #6 (hrjtju)
  }
  return null;
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const day = dt.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  dt.setDate(dt.getDate() + diff);
  return formatDate(dt);
}

function sundayOf(dateStr) {
  const mon = mondayOf(dateStr);
  const [y, m, d] = mon.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + 6);
  return formatDate(dt);
}

function formatDate(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function weekFileName(dateStr) {
  return `${mondayOf(dateStr)}-${sundayOf(dateStr)}.json`;
}

function monthKey(dateStr) {
  return dateStr.slice(0, 7);
}

function yearKey(dateStr) {
  return dateStr.slice(0, 4);
}

function isRecurringDerivedBlock(block) {
  return Boolean(block?.recurringDerived) || String(block?.id || "").startsWith("rec-");
}

function expandRecurring(items, existingBlocks) {
  if (!Array.isArray(items) || !items.length) return [];
  const blocks = [];
  const today = new Date();
  const existingKeys = new Set(
    existingBlocks.map((b) => `${b.date}|${b.start}|${b.taskId || b.title || ""}`)
  );

  items.forEach((item) => {
    if (!Number.isInteger(item.dayOfWeek) || item.dayOfWeek < 0 || item.dayOfWeek > 6) {
      console.warn("expandRecurring: skipping item with invalid dayOfWeek", item.dayOfWeek, item);
      return;
    }
    const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endDate = item.endDate ? new Date(item.endDate + "T00:00:00") : null;

    // expand up to endDate or 1 year from now
    const maxDate = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate());
    const limit = endDate && endDate < maxDate ? endDate : maxDate;

    while (cursor <= limit) {
      if (cursor.getDay() === item.dayOfWeek) {
        const ds = formatDate(cursor);
        const key = `${ds}|${item.start}|${item.taskId || item.title || ""}`;
        if (!existingKeys.has(key)) {
          blocks.push({
            id: `rec-${item.id || ""}-${ds}`,
            recurringId: item.id || "",
            recurringDerived: true,
            date: ds,
            type: "busy",
            taskId: "",
            title: item.title || "",
            start: item.start,
            end: item.end,
            auto: false,
          });
          existingKeys.add(key);
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  });

  return blocks;
}

function loadAllData() {
  const result = {};

  // config
  const config = readJson(CONFIG_FILE) || {};
  result.settings = config.settings || {};
  result.ai = config.ai || {};

  // daily files
  const tasks = [];
  const blocks = [];
  const dayPlans = {};
  const reviews = [];
  if (fs.existsSync(DAILY_DIR)) {
    for (const name of fs.readdirSync(DAILY_DIR)) {
      if (!name.endsWith(".json")) continue;
      const file = readJson(path.join(DAILY_DIR, name));
      if (!file) continue;
      if (Array.isArray(file.tasks)) tasks.push(...file.tasks);
      if (Array.isArray(file.blocks)) blocks.push(...file.blocks.filter((block) => !isRecurringDerivedBlock(block)));
      if (file.dayPlans) Object.assign(dayPlans, file.dayPlans);
      if (Array.isArray(file.reviews)) reviews.push(...file.reviews);
    }
  }
  result.tasks = tasks;
  result.dayPlans = dayPlans;
  result.reviews = reviews;

  // recurring
  const recurring = readJson(RECURRING_FILE) || [];
  result.recurring = recurring;

  // expand recurring into blocks
  const recurringBlocks = expandRecurring(recurring, blocks);
  result.blocks = blocks.concat(recurringBlocks);

  // goals
  const goals = [];
  const index = readJson(INDEX_FILE) || { goals: {} };
  for (const dir of [GOALS_MONTHLY_DIR, GOALS_LONGTERM_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = readJson(path.join(dir, name));
      if (file && Array.isArray(file.goals)) goals.push(...file.goals);
    }
  }
  result.goals = goals;

  return result;
}

function saveAllData(data) {
  // config
  const safeAi = { ...(data.ai || {}) };
  delete safeAi.apiKey;
  writeJson(CONFIG_FILE, { settings: data.settings || {}, ai: safeAi });

  // recurring
  writeJson(RECURRING_FILE, Array.isArray(data.recurring) ? data.recurring : []);
  const persistedBlocks = (data.blocks || []).filter((block) => !isRecurringDerivedBlock(block));

  // group daily items by week and write each week file
  const weekDates = {};
  // Collect all dates that have tasks, blocks, dayPlans, or reviews
  (data.tasks || []).forEach((t) => { if (t.date) weekDates[t.date] = true; });
  persistedBlocks.forEach((b) => { if (b.date) weekDates[b.date] = true; });
  if (data.dayPlans) Object.keys(data.dayPlans).forEach((d) => weekDates[d] = true);
  (data.reviews || []).forEach((r) => { if (r.date) weekDates[r.date] = true; });

  const weekFiles = new Set();
  Object.keys(weekDates).forEach((d) => weekFiles.add(weekFileName(d)));

  weekFiles.forEach((fileName) => {
    const stem = fileName.replace(".json", "");
    const ws = stem.slice(0, 10);
    const we = stem.slice(11, 21);
    writeJson(path.join(DAILY_DIR, fileName), {
      weekStart: ws,
      weekEnd: we,
      tasks: (data.tasks || []).filter((t) => t.date >= ws && t.date <= we),
      blocks: persistedBlocks.filter((b) => b.date >= ws && b.date <= we),
      dayPlans: filterDayPlans(data.dayPlans || {}, ws, we),
      reviews: (data.reviews || []).filter((r) => r.date >= ws && r.date <= we),
    });
  });

  // Clean up: remove weekly files that are no longer in the active set or are empty
  if (fs.existsSync(DAILY_DIR)) {
    for (const name of fs.readdirSync(DAILY_DIR)) {
      if (!name.endsWith(".json")) continue;
      const filePath = path.join(DAILY_DIR, name);
      if (!weekFiles.has(name)) {
        fs.unlinkSync(filePath);
      } else {
        const content = readJson(filePath);
        if (
          !content ||
          (!(content.tasks || []).length &&
           !(content.blocks || []).length &&
           !Object.keys(content.dayPlans || {}).length &&
           !(content.reviews || []).length)
        ) {
          fs.unlinkSync(filePath);
        }
      }
    }
  }

  // goals
  const monthGoals = {};
  const yearGoals = {};
  const index = { goals: {} };

  (data.goals || []).forEach((g) => {
    if (g.type === "long") {
      const yk = yearKey(g.createdAt || new Date().toISOString());
      if (!yearGoals[yk]) yearGoals[yk] = [];
      yearGoals[yk].push(g);
      index.goals[g.id] = `longterm/${yk}.json`;
    } else {
      const mk = monthKey(g.createdAt || new Date().toISOString());
      if (!monthGoals[mk]) monthGoals[mk] = [];
      monthGoals[mk].push(g);
      index.goals[g.id] = `monthly/${mk}.json`;
    }
  });

  // Write month goal files
  const allMonthKeys = new Set(Object.keys(monthGoals));
  // Also read existing month files to get their keys (so we don't lose goals in inactive months)
  if (fs.existsSync(GOALS_MONTHLY_DIR)) {
    for (const name of fs.readdirSync(GOALS_MONTHLY_DIR)) {
      if (name.endsWith(".json")) allMonthKeys.add(name.replace(".json", ""));
    }
  }
  allMonthKeys.forEach((mk) => {
    const existing = readJson(path.join(GOALS_MONTHLY_DIR, `${mk}.json`)) || { goals: [] };
    const updated = existing.goals.filter((g) => {
      // keep if still in data
      return (data.goals || []).some((ng) => ng.id === g.id);
    });
    // add/update from new data
    (monthGoals[mk] || []).forEach((g) => {
      const idx = updated.findIndex((eg) => eg.id === g.id);
      if (idx >= 0) updated[idx] = g;
      else updated.push(g);
    });
    writeJson(path.join(GOALS_MONTHLY_DIR, `${mk}.json`), { month: mk, goals: updated });
  });

  // Write year goal files
  const allYearKeys = new Set(Object.keys(yearGoals));
  if (fs.existsSync(GOALS_LONGTERM_DIR)) {
    for (const name of fs.readdirSync(GOALS_LONGTERM_DIR)) {
      if (name.endsWith(".json")) allYearKeys.add(name.replace(".json", ""));
    }
  }
  allYearKeys.forEach((yk) => {
    const existing = readJson(path.join(GOALS_LONGTERM_DIR, `${yk}.json`)) || { goals: [] };
    const updated = existing.goals.filter((g) => {
      return (data.goals || []).some((ng) => ng.id === g.id);
    });
    (yearGoals[yk] || []).forEach((g) => {
      const idx = updated.findIndex((eg) => eg.id === g.id);
      if (idx >= 0) updated[idx] = g;
      else updated.push(g);
    });
    writeJson(path.join(GOALS_LONGTERM_DIR, `${yk}.json`), { year: yk, goals: updated });
  });

  // Clean up: remove empty goal files
  [GOALS_MONTHLY_DIR, GOALS_LONGTERM_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const filePath = path.join(dir, name);
      const content = readJson(filePath);
      if (!content || !(content.goals || []).length) {
        fs.unlinkSync(filePath);
      }
    }
  });

  // index
  writeJson(INDEX_FILE, index);
}

function filterDayPlans(dayPlans, weekStart, weekEnd) {
  const result = {};
  Object.entries(dayPlans).forEach(([date, plan]) => {
    if (date >= weekStart && date <= weekEnd) result[date] = plan;
  });
  return result;
}

function readBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// 读取原始二进制 body（语音上传用），默认上限 25MB（约 13 分钟 16kHz WAV）
function readRawBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("Audio body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function asrTranscriptionsUrl(baseUrl) {
  const cleanBase = (baseUrl || "https://api.stepfun.com").replace(/\/+$/, "");
  if (cleanBase.endsWith("/audio/transcriptions")) return cleanBase;
  // baseUrl 已带 /v1（如 .../step_plan/v1）时直接拼端点，否则补 /v1——避免 /v1/v1 双前缀 404
  return cleanBase.endsWith("/v1")
    ? `${cleanBase}/audio/transcriptions`
    : `${cleanBase}/v1/audio/transcriptions`;
}

// 把 Node fetch 的网络层错误翻译成可读原因（fetch failed 本身毫无信息量）。
// error.cause.code 常见值：ENOTFOUND（域名解析失败）、ECONNREFUSED、ECONNRESET、
// CERT_*（证书问题）、UND_ERR_HEADERS_TIMEOUT 等。
function describeProxyError(error, label) {
  const code = error?.cause?.code || error?.code || "";
  const target = error?.cause?.hostname ? `（${error.cause.hostname}）` : "";
  if (/aborted|abort/i.test(error?.message || "")) return `${label} 代理：上游请求超时（60 秒无响应）。`;
  if (code === "ENOTFOUND") return `${label} 代理：域名解析失败${target}——检查 API 地址是否填错。`;
  if (code === "ECONNREFUSED") return `${label} 代理：连接被拒绝${target}——服务不可达或需要代理。`;
  if (code === "ECONNRESET") return `${label} 代理：连接被重置${target}——网络中断或被拦截。`;
  if (/CERT|SSL|TLS/i.test(code)) return `${label} 代理：证书校验失败${target}（${code}）。`;
  if (/fetch failed/i.test(error?.message || "")) {
    return `${label} 代理：无法连接上游服务${target}${code ? `（${code}）` : ""}——检查网络 / API 地址 / 是否需要代理。`;
  }
  return `${label} 代理失败：${error?.message || "未知错误"}${code ? `（${code}）` : ""}`;
}

// Step Plan 套餐的 ASR 只暴露 SSE 端点（文档：「当前 Step Plan 下仅可通过
// HTTP + SSE 方式调用」）：POST {base}/audio/asr/sse，JSON + base64 PCM，
// 流式返回 transcript.text.delta / .done 事件。地址含 step_plan 时自动走这条协议。
function isStepPlanAsrBase(baseUrl) {
  return /step_plan/i.test(String(baseUrl || ""));
}

async function callStepPlanAsr({ audioWav, apiKey, baseUrl, model }) {
  // 客户端上传的是 16kHz/16bit/单声道 WAV（44 字节头），剥头即 pcm_s16le
  const pcm = audioWav.length > 44 ? audioWav.subarray(44) : audioWav;
  const url = `${String(baseUrl).replace(/\/+$/, "")}/audio/asr/sse`;
  const body = {
    audio: {
      data: pcm.toString("base64"),
      input: {
        transcription: { model: model || "stepaudio-2.5-asr", language: "zh", enable_itn: true },
        format: { type: "pcm", codec: "pcm_s16le", rate: 16000, bits: 16, channel: 1 },
      },
    },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    let message = text.slice(0, 300);
    try {
      const data = JSON.parse(text);
      message = data?.error?.message || data?.message || message;
    } catch { /* 非 JSON 原文截断即可 */ }
    return { status: upstream.status, body: JSON.stringify({ error: `上游 ASR 返回 ${upstream.status}：${message}` }) };
  }

  // 读完整 SSE 流再解析：短音频几秒到十几秒就结束，无需逐帧转发
  const raw = await upstream.text();
  let finalText = "";
  let deltas = "";
  let errMsg = "";
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const evt = JSON.parse(payload);
      if (evt.type === "transcript.text.done") finalText = evt.text || finalText;
      else if (evt.type === "transcript.text.delta") deltas += evt.delta || "";
      else if (evt.type === "error") errMsg = evt.message || "未知错误";
    } catch { /* 忽略心跳/注释行 */ }
  }
  if (errMsg) {
    return { status: 502, body: JSON.stringify({ error: `上游 ASR 错误：${errMsg}` }) };
  }
  return { status: 200, body: JSON.stringify({ text: (finalText || deltas).trim() }) };
}

function chatCompletionUrl(baseUrl) {
  const cleanBase = (baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  return cleanBase.endsWith("/chat/completions")
    ? cleanBase
    : `${cleanBase}/chat/completions`;
}

function anthropicMessagesUrl(baseUrl) {
  const cleanBase = (baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  return cleanBase.endsWith("/v1/messages") ? cleanBase : `${cleanBase}/v1/messages`;
}

function shouldForwardThinking(payload) {
  const provider = String(payload.provider || "").toLowerCase();
  const baseUrl = String(payload.baseUrl || "").toLowerCase();
  return provider === "deepseek" || baseUrl.includes("deepseek");
}

function toAnthropicMessages(messages = []) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => {
      const raw = message.content;
      if (Array.isArray(raw)) {
        return raw.filter((p) => p.type === "text").map((p) => p.text).join("\n");
      }
      return String(raw || "");
    })
    .filter(Boolean)
    .join("\n\n");

  const turns = [];
  messages
    .filter((message) => message.role !== "system")
    .forEach((message) => {
      const role = message.role === "assistant" ? "assistant" : "user";
      const raw = message.content;
      const content = Array.isArray(raw)
        ? raw.filter((p) => p.type === "text").map((p) => p.text).join("\n")
        : String(raw || "");
      const previous = turns[turns.length - 1];

      if (previous?.role === role) {
        previous.content = `${previous.content}\n\n${content}`;
      } else {
        turns.push({ role, content });
      }
    });

  return { system, messages: turns };
}

function openAiBody(payload) {
  const provider = String(payload.provider || "").toLowerCase();
  const body = {
    model: payload.model || "deepseek-v4-pro",
    messages: payload.messages || [],
    temperature: payload.temperature ?? 0.3,
    stream: false,
  };

  if (provider === "openai" || provider === "minimax") {
    body.max_completion_tokens = payload.max_tokens ?? 1800;
  } else {
    body.max_tokens = payload.max_tokens ?? 1800;
  }

  if (payload.response_format) body.response_format = payload.response_format;
  if (payload.thinking && shouldForwardThinking(payload)) body.thinking = payload.thinking;

  return body;
}

async function callOpenAiCompatible(payload, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(chatCompletionUrl(payload.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(openAiBody(payload)),
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer); // 保证超时定时器一定清理（fetch 抛错也不残留）—— from PR #6 (hrjtju)
  }
}

async function callAnthropic(payload, apiKey) {
  const converted = toAnthropicMessages(payload.messages || []);
  const body = {
    model: payload.model || "claude-opus-4-8",
    max_tokens: payload.max_tokens ?? 1800,
    messages: converted.messages,
  };

  if (converted.system) body.system = converted.system;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const upstream = await fetch(anthropicMessagesUrl(payload.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": payload.anthropicVersion || "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await upstream.text();
    let output = text;
    try {
      const data = JSON.parse(text);
      if (upstream.ok) {
        output = JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: (data.content || [])
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
              },
            },
          ],
          raw: data,
        });
      } else if (data.error) {
        output = JSON.stringify({ error: data.error.message || data.error });
      }
    } catch {
      output = text;
    }

    return {
      status: upstream.status,
      headers: upstream.headers,
      text: async () => output,
    };
  } finally {
    clearTimeout(timer); // from PR #6 (hrjtju)
  }
}

function dataProxy() {
  const handler = async (req, res, next) => {
    // 按 pathname 路由（剥离 query），避免带 ?query 时精确匹配失配 —— from PR #6 (hrjtju)
    const pathname = new URL(req.url, "http://localhost").pathname;
    // data API routes
    if (pathname === "/api/data") {
      if (req.method === "GET") {
        try {
          const data = loadAllData();
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: error.message || "Failed to load data." }));
        }
        return;
      }

      if (req.method === "POST") {
        try {
          const body = JSON.parse(await readBody(req));
          saveAllData(body);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: error.message || "Failed to save data." }));
        }
        return;
      }
    }

    // user profile
    if (pathname === "/api/profile") {
      if (req.method === "GET") {
        try {
          const profile = readJson(PROFILE_FILE) || {};
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(profile));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
      if (req.method === "POST") {
        try {
          const body = JSON.parse(await readBody(req));
          writeJson(PROFILE_FILE, { ...body, updatedAt: new Date().toISOString() });
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
      if (req.method === "DELETE") {
        try {
          if (fs.existsSync(PROFILE_FILE)) fs.unlinkSync(PROFILE_FILE);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
    }

    // AI status check
    if (pathname === "/api/ai/status" && req.method === "GET") {
      const keyOk = !!(process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ configured: keyOk }));
      return;
    }

    // 语音识别代理：浏览器录音转 WAV 后上传这里，转发阶跃 ASR（Key 不落前端）。
    // 默认端点与模型：api.stepfun.com / stepaudio-2.5-asr，可用请求头覆盖。
    if (pathname === "/api/asr" && req.method === "POST") {
      try {
        const audio = await readRawBody(req);
        const apiKey =
          req.headers["x-api-key"] ||
          process.env.AI_API_KEY ||
          process.env.STEPFUN_API_KEY ||
          process.env.DEEPSEEK_API_KEY;
        if (!apiKey) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "缺少语音识别 API Key：请填入 StepFun Key、配置服务器环境变量，或在设置里改用「浏览器识别」。" }));
          return;
        }
        if (!audio.length) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "没有收到音频数据。" }));
          return;
        }
        // Node < 18 没有 FormData/Blob：明确报错而不是抛 ReferenceError 打死整个 dev server
        if (typeof FormData === "undefined" || typeof Blob === "undefined") {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "语音识别代理需要 Node.js 18 或更高版本（当前环境缺少 FormData）。请升级 Node 后重启 dev server，或在设置里改用「浏览器识别」。" }));
          return;
        }
        // Step Plan 套餐：网关只暴露 SSE 协议（/audio/asr/sse，JSON + base64 PCM）
        if (isStepPlanAsrBase(req.headers["x-asr-base-url"])) {
          const result = await callStepPlanAsr({
            audioWav: audio,
            apiKey,
            baseUrl: req.headers["x-asr-base-url"],
            model: req.headers["x-asr-model"],
          });
          res.statusCode = result.status;
          res.setHeader("Content-Type", "application/json");
          res.end(result.body);
          return;
        }
        const form = new FormData();
        form.append("model", req.headers["x-asr-model"] || "stepaudio-2.5-asr");
        form.append("response_format", "json");
        form.append(
          "file",
          new Blob([audio], { type: req.headers["content-type"] || "audio/wav" }),
          "audio.wav",
        );
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60_000);
        let upstream;
        try {
          upstream = await fetch(asrTranscriptionsUrl(req.headers["x-asr-base-url"]), {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        const text = await upstream.text();
        res.statusCode = upstream.status;
        res.setHeader("Content-Type", "application/json");
        // 上游错误若是 HTML/纯文本（404 常见），包装成 JSON 方便前端展示具体原因
        if (!upstream.ok) {
          // 404 几乎一定是 ASR 地址填错——给出两种情形的正确填法
          if (upstream.status === 404) {
            const tried = asrTranscriptionsUrl(req.headers["x-asr-base-url"]);
            res.end(JSON.stringify({
              error: `ASR 端点不存在（404）：${tried}。Step Plan 套餐用户请在设置里把「ASR 地址」填 https://api.stepfun.com/step_plan/v1（自动走套餐 SSE 协议）；非套餐用户填 https://api.stepfun.com。`,
            }));
            return;
          }
          try {
            JSON.parse(text);
            res.end(text);
          } catch {
            res.end(JSON.stringify({ error: `上游 ASR 返回 ${upstream.status}：${text.slice(0, 300)}` }));
          }
        } else {
          res.end(text);
        }
      } catch (error) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: describeProxyError(error, "ASR") }));
      }
      return;
    }

    // AI proxy route
    if (pathname !== "/api/ai/chat" || req.method !== "POST") {
      next();
      return;
    }

    try {
      const payload = JSON.parse(await readBody(req));
      const protocol = payload.protocol || "openai-compatible";
      const apiKey =
        payload.apiKey ||
        process.env.AI_API_KEY ||
        (protocol === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.DEEPSEEK_API_KEY);

      if (!apiKey) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Missing AI API key." }));
        return;
      }

      const upstream =
        protocol === "anthropic"
          ? await callAnthropic(payload, apiKey)
          : await callOpenAiCompatible(payload, apiKey);

      const text = await upstream.text();
      res.statusCode = upstream.status;
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
      res.end(text);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: describeProxyError(error, "AI") }));
    }
  };

  return {
    name: "local-api-proxy",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), dataProxy()],
});
