// 标题归一化、任务/目标身份与去重合并。
import { toMinutes } from "../utils/dateTime.js";
export function titleBigrams(title) {
  const compact = normalizeTitle(title).replace(/[^\u4e00-\u9fa5a-z0-9]/g, "");
  if (compact.length <= 1) return compact ? [compact] : [];
  const grams = [];
  for (let index = 0; index < compact.length - 1; index += 1) {
    grams.push(compact.slice(index, index + 2));
  }
  return grams;
}

export function titleLooksDuplicate(a, b) {
  const left = normalizeTitle(a).replace(/[^\u4e00-\u9fa5a-z0-9]/g, "");
  const right = normalizeTitle(b).replace(/[^\u4e00-\u9fa5a-z0-9]/g, "");
  if (!left || !right) return false;
  if (left === right) return true;
  if (Math.min(left.length, right.length) >= 8 && (left.includes(right) || right.includes(left))) return true;

  const aGrams = new Set(titleBigrams(a));
  const bGrams = new Set(titleBigrams(b));
  if (!aGrams.size || !bGrams.size) return false;
  const smallerSize = Math.min(aGrams.size, bGrams.size);
  // Require higher overlap for very short titles (few unique bigrams)
  const threshold = smallerSize < 4 ? 0.95 : 0.78;
  const overlap = [...aGrams].filter((gram) => bGrams.has(gram)).length;
  return overlap / smallerSize >= threshold;
}

export function titlesReferToSameTask(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  const leftNumbers = left.match(/\d+(?:[.:]\d+)?/g) || [];
  const rightNumbers = right.match(/\d+(?:[.:]\d+)?/g) || [];
  if (leftNumbers.length && rightNumbers.length && leftNumbers.join("|") !== rightNumbers.join("|")) return false;
  return titleLooksDuplicate(left, right);
}

export function compactPlannerTasks(tasks, blocks) {
  const tasksWithoutBusyCommitments = tasks.filter(
    (task) =>
      !(
        (task.fixedTime || task.kind === "fixed") &&
        blocks.some(
          (block) =>
            block.type === "busy" &&
            block.date === task.date &&
            titlesReferToSameTask(block.title, task.title),
        )
      ),
  );
  const { tasks: compactedTasks, canonicalIdByTaskId } = compactTaskList(tasksWithoutBusyCommitments);
  const taskById = Object.fromEntries(compactedTasks.map((task) => [task.id, task]));
  const migratedBlocks = blocks
    .map((block) => {
      const canonicalTaskId = block.taskId ? canonicalIdByTaskId.get(block.taskId) : "";
      return canonicalTaskId && canonicalTaskId !== block.taskId ? { ...block, taskId: canonicalTaskId } : block;
    })
    .filter((block) => !block.taskId || Boolean(taskById[block.taskId]));
  const compactedBlocks = [];

  migratedBlocks.forEach((block) => {
    if (!block.taskId) {
      compactedBlocks.push(block);
      return;
    }

    const task = taskById[block.taskId];
    const duplicateIndex = compactedBlocks.findIndex((existing) => {
      if (!existing.taskId || existing.date !== block.date) return false;
      const existingTask = taskById[existing.taskId];
      const sameTask = existing.taskId === block.taskId || titlesReferToSameTask(existingTask?.title, task?.title);
      return sameTask && overlapsAny(existing, block);
    });

    if (duplicateIndex < 0) {
      compactedBlocks.push(block);
      return;
    }

    const previous = compactedBlocks[duplicateIndex];
    if (previous.auto && !block.auto) compactedBlocks[duplicateIndex] = block;
  });

  return { tasks: compactedTasks, blocks: compactedBlocks };
}

export function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[\s，。！？、,.!?;；:："'"''（）()[\]【】《》<>-]/g, "")
    .trim();
}

export function taskIdentity(task) {
  return `${task.date || ""}|${normalizeTitle(task.title)}`;
}

export function goalIdentity(goal) {
  return `${goal.parentId || ""}|${goal.type || ""}|${normalizeTitle(goal.title)}`;
}

export function mergeTaskFields(previous, current) {
  const previousIsManual = !previous.goalId;
  const currentIsManual = !current.goalId;
  const shouldPreferCurrent =
    (!previousIsManual && currentIsManual) ||
    (previous.status !== "done" && current.status === "done") ||
    (previous.createdAt && current.createdAt && current.createdAt < previous.createdAt && previousIsManual === currentIsManual);
  const preferred = shouldPreferCurrent ? current : previous;
  const fallback = shouldPreferCurrent ? previous : current;

  return {
    ...fallback,
    ...preferred,
    id: previous.id,
    goalId: preferred.goalId || fallback.goalId || "",
    status: previous.status === "done" || current.status === "done" ? "done" : preferred.status,
  };
}

export function compactTaskList(tasks) {
  const compacted = [];
  const canonicalIdByTaskId = new Map();

  tasks.forEach((task) => {
    if (!normalizeTitle(task.title)) return;
    const duplicateIndex = compacted.findIndex(
      (existing) => existing.date === task.date && titlesReferToSameTask(existing.title, task.title),
    );

    if (duplicateIndex < 0) {
      compacted.push(task);
      canonicalIdByTaskId.set(task.id, task.id);
      return;
    }

    const canonical = compacted[duplicateIndex];
    compacted[duplicateIndex] = mergeTaskFields(canonical, task);
    canonicalIdByTaskId.set(task.id, canonical.id);
  });

  return { tasks: compacted, canonicalIdByTaskId };
}

export function mergeDuplicateTasks(tasks) {
  return compactTaskList(tasks).tasks;
}

export function hasSharedPlanningObject(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  const anchors = ["项目", "文档", "材料", "课题", "申请", "报告", "子章节", "文献", "框架", "初稿", "火车", "高铁", "车票"];
  if (anchors.some((word) => left.includes(word) && right.includes(word))) return true;

  const leftTokens = left.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  return leftTokens.some((token) => token.length >= 3 && right.includes(token));
}


export function overlapsAny(block, blocks) {
  if (!Array.isArray(blocks)) return false;
  const start = toMinutes(block.start);
  const end = toMinutes(block.end);
  return blocks.some((item) => start < toMinutes(item.end) && end > toMinutes(item.start));
}
