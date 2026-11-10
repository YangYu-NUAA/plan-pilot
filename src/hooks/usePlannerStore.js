import { useEffect, useRef, useState } from "react";

import { defaultState } from "../app/initialState.js";
import { STORAGE_KEY } from "../constants/appConstants.js";
import { hasLocalServer, isElectron } from "../app/platform.js";
import { getFileSyncIssueText } from "../app/platformMessages.js";
import { hydrateState } from "../planner/hydration.js";
import { createPlannerSyncController } from "./plannerSyncController.js";

function hasPlannerContent(fileData) {
  return (
    (Array.isArray(fileData.tasks) && fileData.tasks.length > 0) ||
    (Array.isArray(fileData.blocks) && fileData.blocks.length > 0) ||
    (Array.isArray(fileData.goals) && fileData.goals.length > 0) ||
    (fileData.dayPlans != null && typeof fileData.dayPlans === "object" && Object.keys(fileData.dayPlans).length > 0) ||
    (Array.isArray(fileData.reviews) && fileData.reviews.length > 0) ||
    (Array.isArray(fileData.recurring) && fileData.recurring.length > 0) ||
    (fileData.settings != null && typeof fileData.settings === "object" && Object.keys(fileData.settings).length > 0) ||
    (fileData.ai != null && typeof fileData.ai === "object" && Object.keys(fileData.ai).length > 0)
  );
}

export function hydratePlannerState(input, mergeTasks) {
  return hydrateState(input, { mergeTasks });
}

// 只负责 planner 持久化：localStorage 启动、文件同步，以及加载后的数据压缩。
// 文件同步失败会在 UI 亮出可关闭提示；恢复后的成功读写会清除提示。
export function usePlannerStore({ compactPlannerTasks, mergeTasks }) {
  const [state, setState] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? hydratePlannerState(JSON.parse(raw), mergeTasks) : defaultState;
    } catch {
      return defaultState;
    }
  });
  const [loaded, setLoaded] = useState(false);
  const [syncIssue, setSyncIssue] = useState(null); // null=正常；非 null=文件同步不可达
  const mergeTasksRef = useRef(mergeTasks);
  const syncControllerRef = useRef(null);
  mergeTasksRef.current = mergeTasks;

  // 同一个控制器跨 React StrictMode 的 Effect setup/cleanup 保留写队列，旧写入不会与新保存并行。
  if (hasLocalServer && !syncControllerRef.current) {
    syncControllerRef.current = createPlannerSyncController({
      fetchImpl: (...args) => fetch(...args),
      hydrate: (fileData) => hydratePlannerState(fileData, mergeTasksRef.current),
      hasContent: hasPlannerContent,
      readLocal: () => localStorage.getItem(STORAGE_KEY),
      onHydrate: (merged) => {
        // 文件数据存在时优先使用文件，再把恢复后的结构同步回 localStorage。
        setState(merged);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        } catch (error) {
          console.error("localStorage write failed:", error);
        }
      },
      onLoaded: () => setLoaded(true),
      onSyncIssue: setSyncIssue,
      syncIssueText: getFileSyncIssueText({ electron: isElectron }),
    });
  }

  useEffect(() => {
    // Android 原生壳无本机服务器：直接走 localStorage，不发 /api/data 请求。
    if (!hasLocalServer) {
      setLoaded(true);
      return undefined;
    }

    setLoaded(false);
    const controller = syncControllerRef.current;
    controller.start();
    return () => controller.stop();
  }, [mergeTasks]);

  useEffect(() => {
    setState((current) => {
      const compacted = compactPlannerTasks(current.tasks, current.blocks);
      const tasksChanged = compacted.tasks.length !== current.tasks.length;
      const blocksChanged =
        compacted.blocks.length !== current.blocks.length ||
        compacted.blocks.some((block, index) => block !== current.blocks[index]);

      return tasksChanged || blocksChanged ? { ...current, ...compacted } : current;
    });
  }, [compactPlannerTasks, loaded]);

  useEffect(() => {
    if (!loaded) return;

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.error("localStorage write failed:", error);
    }

    // 文件写入由控制器防抖并串行化；首次加载未终结前不会安排 POST。
    if (hasLocalServer) syncControllerRef.current?.scheduleSave(state);
  }, [state, loaded]);

  return [state, setState, syncIssue];
}
