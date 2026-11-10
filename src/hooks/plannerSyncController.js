const noop = () => {};

/**
 * 协调首次文件水合、失败重试与后续保存，不依赖 React 或浏览器定时器。
 * 所有 POST 共用一条队列；Effect 重放或依赖变化时，旧异步回调也不能污染新一轮状态。
 */
export function createPlannerSyncController({
  fetchImpl,
  hydrate,
  hasContent,
  readLocal,
  onHydrate = noop,
  onLoaded = noop,
  onSyncIssue = noop,
  syncIssueText,
  maxAttempts = 3,
  retryDelayMs = 3000,
  saveDelayMs = 2000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  let generation = 0;
  let active = false;
  let loaded = false;
  let attempts = 0;
  let retryTimer = null;
  let saveTimer = null;
  let writeQueue = Promise.resolve();

  function isCurrent(runGeneration) {
    return active && generation === runGeneration;
  }

  function clearRetryTimer() {
    if (retryTimer !== null) clearTimeoutImpl(retryTimer);
    retryTimer = null;
  }

  function clearSaveTimer() {
    if (saveTimer !== null) clearTimeoutImpl(saveTimer);
    saveTimer = null;
  }

  function finishLoad(runGeneration) {
    if (!isCurrent(runGeneration) || loaded) return;
    loaded = true;
    clearRetryTimer();
    onLoaded();
  }

  function enqueuePost(raw, runGeneration) {
    async function write() {
      if (!isCurrent(runGeneration)) return;
      try {
        const response = await fetchImpl("/api/data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: raw,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (isCurrent(runGeneration)) onSyncIssue(null);
      } catch {
        if (isCurrent(runGeneration)) onSyncIssue(syncIssueText);
      }
    }

    // 初始化 POST 与后续保存、以及相邻两次保存，都严格按入队顺序执行。
    writeQueue = writeQueue.then(write, write);
    return writeQueue;
  }

  async function load(runGeneration) {
    try {
      const response = await fetchImpl("/api/data");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const fileData = await response.json();
      if (!fileData || fileData.error) throw new Error(fileData?.error || "Empty response");
      if (!isCurrent(runGeneration)) return;

      onSyncIssue(null);
      if (hasContent(fileData)) {
        const merged = hydrate(fileData);
        if (!isCurrent(runGeneration)) return;
        onHydrate(merged);
        finishLoad(runGeneration);
        return;
      }

      // 空文件需要先由 localStorage 初始化。初始化 POST 结束后才解锁保存，
      // 因此后续保存不可能先于它到达服务器。
      const localRaw = readLocal();
      if (localRaw) await enqueuePost(localRaw, runGeneration);
      finishLoad(runGeneration);
    } catch {
      if (!isCurrent(runGeneration)) return;
      attempts += 1;
      if (attempts >= maxAttempts) {
        onSyncIssue(syncIssueText);
        // 最终失败也允许继续使用 localStorage 并尝试保存，避免应用一直只读。
        finishLoad(runGeneration);
      } else {
        // 失败重试期间保持 loaded=false：绝不能用旧 localStorage 触发 POST。
        retryTimer = setTimeoutImpl(() => {
          retryTimer = null;
          return load(runGeneration);
        }, retryDelayMs);
      }
    }
  }

  return {
    start() {
      generation += 1;
      const runGeneration = generation;
      active = true;
      loaded = false;
      attempts = 0;
      clearRetryTimer();
      clearSaveTimer();
      return load(runGeneration);
    },

    stop() {
      active = false;
      loaded = false;
      generation += 1;
      clearRetryTimer();
      clearSaveTimer();
    },

    scheduleSave(state) {
      if (!active || !loaded) return;
      clearSaveTimer();
      const runGeneration = generation;
      saveTimer = setTimeoutImpl(() => {
        saveTimer = null;
        if (!isCurrent(runGeneration)) return;
        return enqueuePost(JSON.stringify(state), runGeneration);
      }, saveDelayMs);
    },

    get loaded() {
      return loaded;
    },
  };
}
