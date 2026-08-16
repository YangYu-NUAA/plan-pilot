import { CapacitorHttp } from "@capacitor/core";

// 原生壳直连模式：用 CapacitorHttp（原生 HTTP 栈）直接调供应商端点，
// 绕过 WebView CORS，不再依赖 /api/ai/chat 代理。
// 请求构造与 vite.config.js 里服务器代理的逻辑保持一致（openAiBody / anthropic 转换）。

function chatCompletionUrl(baseUrl) {
  const clean = (baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  return clean.endsWith("/chat/completions") ? clean : `${clean}/chat/completions`;
}

function anthropicMessagesUrl(baseUrl) {
  const clean = (baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  return clean.endsWith("/v1/messages") ? clean : `${clean}/v1/messages`;
}

function shouldForwardThinking(payload) {
  const provider = String(payload.provider || "").toLowerCase();
  const baseUrl = String(payload.baseUrl || "").toLowerCase();
  return provider === "deepseek" || baseUrl.includes("deepseek");
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

function toAnthropicMessages(messages = []) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n") : String(m.content || "")))
    .filter(Boolean)
    .join("\n\n");
  const turns = [];
  messages
    .filter((m) => m.role !== "system")
    .forEach((m) => {
      const role = m.role === "assistant" ? "assistant" : "user";
      const content = Array.isArray(m.content)
        ? m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n")
        : String(m.content || "");
      const prev = turns[turns.length - 1];
      if (prev?.role === role) prev.content = `${prev.content}\n\n${content}`;
      else turns.push({ role, content });
    });
  return { system, messages: turns };
}

// 把 CapacitorHttp 的结果包装成 fetch Response 的最小兼容形态
function asResponse(status, data) {
  const text = typeof data === "string" ? data : JSON.stringify(data ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    },
  };
}

async function openAiDirect(payload) {
  const response = await CapacitorHttp.post({
    url: chatCompletionUrl(payload.baseUrl),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${payload.apiKey}`,
    },
    data: openAiBody(payload),
    connectTimeout: 60_000,
    readTimeout: 60_000,
  });
  return asResponse(response.status, response.data);
}

async function anthropicDirect(payload) {
  const converted = toAnthropicMessages(payload.messages || []);
  const body = {
    model: payload.model || "claude-opus-4-8",
    max_tokens: payload.max_tokens ?? 1800,
    messages: converted.messages,
  };
  if (converted.system) body.system = converted.system;
  const response = await CapacitorHttp.post({
    url: anthropicMessagesUrl(payload.baseUrl),
    headers: {
      "Content-Type": "application/json",
      "x-api-key": payload.apiKey,
      "anthropic-version": payload.anthropicVersion || "2023-06-01",
    },
    data: body,
    connectTimeout: 60_000,
    readTimeout: 60_000,
  });
  // 与服务器代理一致：把 Anthropic 响应折算成 OpenAI 形态
  const raw = response.data || {};
  let out = raw;
  if (response.status >= 200 && response.status < 300) {
    const text = (raw.content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
    out = { choices: [{ message: { role: "assistant", content: text } }], raw };
  } else if (raw.error) {
    out = { error: raw.error.message || raw.error };
  }
  return asResponse(response.status, out);
}

// 与 callPlanningAi 的 fetchImpl 同签名（忽略代理 URL，按 payload 直连）
export async function directChatFetch(_proxyUrl, { body }) {
  const payload = JSON.parse(body);
  const protocol = payload.protocol || "openai-compatible";
  return protocol === "anthropic" ? anthropicDirect(payload) : openAiDirect(payload);
}
