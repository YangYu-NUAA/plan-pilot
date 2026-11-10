import { test } from "node:test";
import assert from "node:assert/strict";

import { callPlanningAi } from "../src/ai/callPlanningAi.js";

function makeResponse({ ok = true, body = {}, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
  };
}

const baseAi = {
  provider: "custom",
  protocol: "openai-compatible",
  baseUrl: "https://example.com/v1",
  model: "test-model",
  apiKey: undefined,
};

test("无 Key 且 serverKeyOk=false：直接抛错，不发起 fetch", async () => {
  let called = 0;
  const fetchImpl = () => {
    called += 1;
    return makeResponse();
  };

  await assert.rejects(
    callPlanningAi({ ai: baseAi, messages: [], fetchImpl }),
    /未配置 API Key/,
  );
  assert.equal(called, 0, "未配置 Key 时不应发起 fetch，避免无谓的 400 网络请求");
});

test("serverKeyOk=true 时即使无 Key 也走 fetch（让服务端 env 接管）", async () => {
  let called = 0;
  const fetchImpl = async () => {
    called += 1;
    return makeResponse({
      body: { choices: [{ message: { content: '{"message":"ok","actions":[]}' }, finish_reason: "stop" }] },
    });
  };

  const result = await callPlanningAi({
    ai: baseAi,
    messages: [{ role: "user", content: "hi" }],
    serverKeyOk: true,
    fetchImpl,
  });
  assert.equal(called, 1);
  assert.equal(result.message, "ok");
});

test("第一次返回空对象 + 第二次返回有意义 JSON：返回第二次的结果", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const body = calls === 1
      ? { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }
      : {
          choices: [{
            message: { content: '{"message":"已加","actions":[{"type":"add_task","title":"写论文"}]}' },
            finish_reason: "stop",
          }],
        };
    return makeResponse({ body });
  };

  const result = await callPlanningAi({
    ai: baseAi,
    apiKey: "test-key",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl,
  });
  assert.equal(calls, 2, "第一次退化时应自动重试一次");
  assert.equal(result.message, "已加");
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].title, "写论文");
});

test("正文空 + reasoning 含 JSON：从 reasoning 抽出（弱模型典型路径）", async () => {
  // 模拟 step-3.7-flash 把答案写进 reasoning、正文只给空
  const reasoning = '思考：用户想要加任务。\n{"message":"已加","actions":[{"type":"add_task","title":"写论文"}]}';
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return makeResponse({
      body: { choices: [{ message: { content: "", reasoning }, finish_reason: "stop" }] },
    });
  };

  const result = await callPlanningAi({
    ai: baseAi,
    apiKey: "test-key",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl,
  });
  assert.equal(calls, 1, "reasoning 抽出成功则不重试");
  assert.equal(result.message, "已加");
  assert.equal(result.actions[0].title, "写论文");
});

test("三次都退化（{}）：返回第一次拿到的退化对象作为兜底", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return makeResponse({
      body: { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] },
    });
  };

  const result = await callPlanningAi({
    ai: baseAi,
    apiKey: "test-key",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl,
  });
  assert.equal(calls, 3, "应跑满 3 次降级");
  assert.deepEqual(result, {}, "全部退化时退而求其次返回第一次的退化对象");
});

test("三次都 finish_reason=length：抛错告知已重试", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return makeResponse({
      body: { choices: [{ message: { content: "", reasoning: "" }, finish_reason: "length" }] },
    });
  };

  await assert.rejects(
    callPlanningAi({
      ai: baseAi,
      apiKey: "test-key",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
    }),
    /已自动重试/,
  );
  assert.equal(calls, 3, "应跑满 3 次");
});

test("fetch 网络层失败（Failed to fetch）：抛出明确中文提示且不重试", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new TypeError("Failed to fetch");
  };

  await assert.rejects(
    callPlanningAi({
      ai: baseAi,
      apiKey: "test-key",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
    }),
    /本地 API 代理不可达/,
  );
  assert.equal(calls, 1, "网络层不可达重试无意义，应只尝试一次");
});

test("非 JSON 模式 fetch 网络层失败：同样抛出明确中文提示", async () => {
  const fetchImpl = async () => {
    throw new TypeError("Failed to fetch");
  };

  await assert.rejects(
    callPlanningAi({
      ai: baseAi,
      apiKey: "test-key",
      messages: [{ role: "user", content: "hi" }],
      json: false,
      fetchImpl,
    }),
    /本地 API 代理不可达/,
  );
});

test("deepseek 服务商：自动追加 thinking=disabled（避免 reasoning 干扰 JSON）", async () => {
  let sentBody = null;
  const fetchImpl = async (url, init) => {
    sentBody = JSON.parse(init.body);
    return makeResponse({
      body: { choices: [{ message: { content: '{"message":"ok","actions":[]}' }, finish_reason: "stop" }] },
    });
  };

  await callPlanningAi({
    ai: { ...baseAi, provider: "deepseek" },
    apiKey: "test-key",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl,
  });
  assert.deepEqual(sentBody.thinking, { type: "disabled" });
});

test("JSON 模式下 maxTokens < 5000 时被夹到 5000 下限（保证推理模型能写完）", async () => {
  let sentBody = null;
  const fetchImpl = async (url, init) => {
    sentBody = JSON.parse(init.body);
    return makeResponse({
      body: { choices: [{ message: { content: '{"message":"ok","actions":[]}' }, finish_reason: "stop" }] },
    });
  };

  await callPlanningAi({
    ai: baseAi,
    apiKey: "test-key",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 1000,
    fetchImpl,
  });
  assert.equal(sentBody.max_tokens, 5000);
});

test("非 JSON 模式：正文有 plain text → 返回 message/items 兜底对象", async () => {
  const fetchImpl = async () =>
    makeResponse({
      body: { choices: [{ message: { content: "好的，我已经记下来了。" }, finish_reason: "stop" }] },
    });

  const result = await callPlanningAi({
    ai: baseAi,
    apiKey: "test-key",
    messages: [{ role: "user", content: "hi" }],
    json: false,
    fetchImpl,
  });
  assert.equal(result.message, "好的，我已经记下来了。");
  assert.deepEqual(result.items, []);
});