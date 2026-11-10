import { test } from "node:test";
import assert from "node:assert/strict";

import { createPlannerSyncController } from "../src/hooks/plannerSyncController.js";

const ISSUE = "sync unavailable";

function response(body = {}, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function timerHarness() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, delay) {
      const id = nextId++;
      pending.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    get size() {
      return pending.size;
    },
    async runNext() {
      assert.ok(pending.size > 0, "应当有待执行的定时器");
      const [id, task] = pending.entries().next().value;
      pending.delete(id);
      return task.fn();
    },
  };
}

function makeController({ fetchImpl, timers, localRaw = null, hydrated = [], loaded = [], issues = [] }) {
  return createPlannerSyncController({
    fetchImpl,
    hydrate: (fileData) => ({ ...fileData, hydrated: true }),
    hasContent: (fileData) => Array.isArray(fileData.tasks) && fileData.tasks.length > 0,
    readLocal: () => localRaw,
    onHydrate: (state) => hydrated.push(state),
    onLoaded: () => loaded.push(true),
    onSyncIssue: (issue) => issues.push(issue),
    syncIssueText: ISSUE,
    retryDelayMs: 10,
    saveDelayMs: 20,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });
}

test("首次 GET 失败后的重试期间不 POST，成功水合后才允许保存", async () => {
  const calls = [];
  const hydrated = [];
  const loaded = [];
  const timers = timerHarness();
  const serverState = { tasks: [{ id: "from-server" }] };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body });
    if (calls.length === 1) throw new TypeError("Failed to fetch");
    if (calls.length === 2) return response(serverState);
    return response();
  };
  const controller = makeController({
    fetchImpl,
    timers,
    localRaw: JSON.stringify({ tasks: [{ id: "stale-local" }] }),
    hydrated,
    loaded,
  });

  await controller.start();
  assert.equal(controller.loaded, false);
  assert.deepEqual(loaded, []);
  assert.equal(timers.size, 1, "仅安排 GET 重试");
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);

  // 即使保存 effect 被误触发，控制器也必须拒绝重试期间的旧状态。
  controller.scheduleSave({ tasks: [{ id: "stale-local" }] });
  assert.equal(timers.size, 1, "重试期间不得新增保存定时器");
  assert.equal(calls.length, 1);

  await timers.runNext();
  assert.equal(controller.loaded, true);
  assert.deepEqual(loaded, [true]);
  assert.equal(hydrated.length, 1);
  assert.equal(hydrated[0].tasks[0].id, "from-server");
  assert.equal(hydrated[0].hydrated, true);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET"]);

  controller.scheduleSave(hydrated[0]);
  await timers.runNext();
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET", "POST"]);
  assert.equal(JSON.parse(calls[2].body).tasks[0].id, "from-server", "不得回写重试前的旧 localStorage");
});

test("首次 GET 最终失败后才解锁本地状态保存", async () => {
  const calls = [];
  const loaded = [];
  const issues = [];
  const timers = timerHarness();
  const fetchImpl = async (url, init = {}) => {
    calls.push({ method: init.method || "GET", body: init.body });
    if (!init.method) throw new TypeError("Failed to fetch");
    return response();
  };
  const controller = makeController({ fetchImpl, timers, loaded, issues });

  await controller.start();
  await timers.runNext();
  assert.equal(controller.loaded, false, "第二次失败后仍有重试，不提前解锁");
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET"]);

  await timers.runNext();
  assert.equal(controller.loaded, true);
  assert.deepEqual(loaded, [true]);
  assert.equal(issues.at(-1), ISSUE);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET", "GET"]);

  controller.scheduleSave({ tasks: [{ id: "local-after-final-failure" }] });
  await timers.runNext();
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET", "GET", "POST"]);
  assert.equal(JSON.parse(calls[3].body).tasks[0].id, "local-after-final-failure");
});

test("空文件初始化 POST 完成后才解锁，后续保存与其串行", async () => {
  const calls = [];
  const loaded = [];
  const timers = timerHarness();
  const initialization = deferred();
  const initializationStarted = deferred();
  const localRaw = JSON.stringify({ tasks: [{ id: "initialize" }] });
  const fetchImpl = async (url, init = {}) => {
    calls.push({ method: init.method || "GET", body: init.body });
    if (!init.method) return response({});
    if (calls.length === 2) {
      initializationStarted.resolve();
      return initialization.promise;
    }
    return response();
  };
  const controller = makeController({ fetchImpl, timers, localRaw, loaded });

  const loading = controller.start();
  await initializationStarted.promise;
  assert.equal(controller.loaded, false);
  assert.deepEqual(loaded, []);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "POST"]);
  assert.equal(calls[1].body, localRaw);

  controller.scheduleSave({ tasks: [{ id: "must-not-race" }] });
  assert.equal(timers.size, 0, "初始化未完成时不能安排后续保存");

  initialization.resolve(response());
  await loading;
  assert.equal(controller.loaded, true);
  controller.scheduleSave({ tasks: [{ id: "after-initialization" }] });
  await timers.runNext();

  assert.deepEqual(calls.map((call) => call.method), ["GET", "POST", "POST"]);
  assert.equal(JSON.parse(calls[2].body).tasks[0].id, "after-initialization");
});

test("保存失败显示同步问题，后续保存成功清除问题", async () => {
  const calls = [];
  const issues = [];
  const timers = timerHarness();
  const fetchImpl = async (url, init = {}) => {
    calls.push(init.method || "GET");
    if (!init.method) return response({ tasks: [{ id: "server" }] });
    if (calls.length === 2) throw new TypeError("Failed to fetch");
    return response();
  };
  const controller = makeController({ fetchImpl, timers, issues });

  await controller.start();
  controller.scheduleSave({ tasks: [{ id: "first-save" }] });
  await timers.runNext();
  assert.equal(issues.at(-1), ISSUE);

  controller.scheduleSave({ tasks: [{ id: "recovered-save" }] });
  await timers.runNext();
  assert.equal(issues.at(-1), null);
});
