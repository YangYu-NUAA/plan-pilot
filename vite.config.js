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
      res.end(JSON.stringify({ error: error.message || "AI proxy failed." }));
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
