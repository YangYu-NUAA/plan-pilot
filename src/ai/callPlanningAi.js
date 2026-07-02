import { tryExtractJson, richestJson, isMeaningfulJson } from "../jsonExtract.js";

function flattenMessageContent(value) {
  return Array.isArray(value)
    ? value.map((part) => (typeof part === "string" ? part : part?.text || "")).join("")
    : String(value || "");
}

export async function callPlanningAi({
  ai,
  apiKey: explicitApiKey,
  messages,
  maxTokens = 1800,
  json = true,
  serverKeyOk = false,
  fetchImpl = fetch,
}) {
  // 浏览器 + 服务端都没 Key 时直接抛错，避免触发 400 网络请求。
  // serverKeyOk 由调用方根据 mount 时 /api/ai/status 的查询结果传入。
  const apiKey = explicitApiKey || ai.apiKey || undefined;
  if (!apiKey && !serverKeyOk) {
    throw new Error("未配置 API Key。请在设置中添加浏览器 Key，或检查服务端环境变量（AI_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY）。");
  }

  // 推理型模型（step-3.7-flash 等）会把 token 预算先花在「思考」(message.reasoning) 上，
  // 预算太小会在写正文前就被 finish_reason=length 截断、content 为空。
  // 所以 JSON 模式给一个较高的下限，保证「想完还能把 JSON 写出来」。非推理模型用不满，不会涨成本。
  const effectiveMax = json ? Math.max(maxTokens, 5000) : maxTokens;

  // 单次调用：jsonMode=是否启用严格 json_object（弱模型常因此返回空）；extra=追加的纠正消息
  async function once(jsonMode, extra) {
    const response = await fetchImpl("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: ai.provider,
        protocol: ai.protocol || "openai-compatible",
        baseUrl: ai.baseUrl,
        model: ai.model,
        apiKey,
        messages: extra ? messages.concat(extra) : messages,
        max_tokens: effectiveMax,
        temperature: 0.2,
        ...(jsonMode && json ? { response_format: { type: "json_object" } } : {}),
        ...(ai.provider === "deepseek" ? { thinking: { type: "disabled" } } : {}),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.error || "AI 调用失败。");

    const top = data.choices?.[0] || {};
    const choice = top.message || {};
    const content = flattenMessageContent(choice.content).trim();
    // 推理模型（step-3.7-flash 等）常把真正的答案写进 reasoning，正文只给 {} 或空——单独留存供回退。
    const reasoning = flattenMessageContent(choice.reasoning ?? choice.reasoning_content).trim();
    if (!content && !reasoning && top.finish_reason === "length") {
      throw new Error("模型把 token 预算都用在思考上、正文被截断（finish_reason=length）。请调大 max_tokens，或在模型侧关闭推理模式。");
    }
    return { content, reasoning };
  }

  if (!json) {
    const { content, reasoning } = await once(false);
    return tryExtractJson(content) || tryExtractJson(reasoning) || { message: content || reasoning, items: [] };
  }

  // JSON 模式：生成 → 校验 → 修复，逐步降级，最多 3 次，让弱模型也能稳定吐 JSON
  // 第 1 次走严格 json_object（多数模型更稳）；但 step-3.7-flash 在该模式下爱只吐 "{}"，
  // 把答案留在 reasoning，所以第 2/3 次关掉该模式 + 追一句，更可能把完整 JSON 写进正文。
  const tries = [
    () => once(true),
    () => once(false, [{ role: "user", content: "你上一条只返回了空对象或没有正文。请把【完整】的 JSON 结果直接作为正文返回——不要把内容只写在思考 / reasoning 里、不要只给 {}；以 { 开头、} 结尾，不要 Markdown、不要任何解释。" }]),
    () => once(false, [{ role: "user", content: "再试一次：只输出一个内容非空的完整 JSON 对象作为正文，把该填的字段都填上，其余一律不要。" }]),
  ];
  let lastError = null;
  let degenerateFallback = null;

  for (const run of tries) {
    let result;
    try {
      result = await run();
    } catch (error) {
      lastError = error;
      continue;
    }

    const { content, reasoning } = result;
    // 1) 优先用正文里的有意义 JSON
    const fromContent = content ? tryExtractJson(content) : null;
    if (isMeaningfulJson(fromContent)) return fromContent;

    // 2) 正文退化（step-3.7-flash 只吐 "{}"、答案在 reasoning）：从 reasoning 捞最终 JSON
    const fromReasoning = reasoning ? richestJson(reasoning) : null;
    if (isMeaningfulJson(fromReasoning)) return fromReasoning;

    // 3) 拿到的是退化空对象：记下来但【继续重试】，绝不在这里短路（否则白白浪费后两次更可能成功的尝试）
    if (fromContent && !degenerateFallback) degenerateFallback = fromContent;
    lastError = new Error(!content && !reasoning ? "AI 没有返回可用内容。" : "AI 返回的内容为空 / 退化。");
  }

  if (degenerateFallback) return degenerateFallback; // 三次都没拿到有意义结果，退而求其次
  throw new Error(`${lastError?.message || "AI 调用失败"}（已自动重试，仍未拿到可用 JSON；可换更稳的模型如 DeepSeek）。`);
}
