// 排程核心：自动安排、AI 排期结果归一化、工作时段裁剪与冲突校验。
import { uid } from "../utils/ids.js";
import { duration, toMinutes, toTime } from "../utils/dateTime.js";
import {
  isMeetingSentence,
  isPostMeetingTask,
  isTicketPurchaseTask,
} from "../planningSemantics.js";
import { priorityOrder } from "../constants/labels.js";
import { sum } from "../utils/form.js";
import {
  compactPlannerTasks,
  hasSharedPlanningObject,
  normalizeTitle,
  titlesReferToSameTask,
  overlapsAny,
} from "./dedup.js";
import { estimateMinutesForTitle, parseTimeInSentence } from "./textExtract.js";

export function shouldScheduleBefore(first, second) {
  const a = String(first?.title || "");
  const b = String(second?.title || "");

  if (/打印|复印/.test(a) && /扫描|上传|提交/.test(b) && hasSharedPlanningObject(a, b)) return true;
  if (/扫描/.test(a) && /上传|提交/.test(b) && hasSharedPlanningObject(a, b)) return true;
  if (/整理|梳理|确定|大纲|框架|核心观点/.test(a) && /撰写|写作|初稿/.test(b) && hasSharedPlanningObject(a, b)) return true;
  if (isTicketPurchaseTask(a) && /出发|前往|返回|乘车|赶车/.test(b)) return true;

  return false;
}

export function scheduleUrgencyScore(task) {
  const title = String(task?.title || "");
  let score = 0;
  if (isTicketPurchaseTask(title) && /今天|下午|晚上|火车|高铁|航班/.test(title)) score += 5;
  if (/提交|上传|打印|扫描|发送/.test(title)) score += 1;
  if (/准备|确认/.test(title)) score += 0.5;
  return score;
}

export function compareTasksForScheduling(a, b) {
  if (shouldScheduleBefore(a, b)) return -1;
  if (shouldScheduleBefore(b, a)) return 1;

  const urgencyDelta = scheduleUrgencyScore(b) - scheduleUrgencyScore(a);
  if (urgencyDelta !== 0) return urgencyDelta;

  const priorityDelta = priorityOrder[b.priority] - priorityOrder[a.priority];
  if (priorityDelta !== 0) return priorityDelta;

  return Number(a.estimateMinutes || 0) - Number(b.estimateMinutes || 0);
}

export function latestMeetingEnd(blocks) {
  const meetingBlocks = blocks.filter((block) => block.type === "busy" && isMeetingSentence(block.title || ""));
  if (!meetingBlocks.length) return null;
  return Math.max(...meetingBlocks.map((block) => toMinutes(block.end)));
}

export function meetingEndForTask(taskTitle, blocks) {
  const meetingBlocks = blocks.filter((block) => block.type === "busy" && isMeetingSentence(block.title || ""));
  if (!meetingBlocks.length) return null;

  const title = String(taskTitle || "");
  const related = meetingBlocks.filter((block) => hasSharedPlanningObject(title, block.title));

  return Math.max(...(related.length ? related : meetingBlocks).map((block) => toMinutes(block.end)));
}

export function sortBlocks(blocks) {
  return [...blocks].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
}

// Greedy lane assignment for overlapping blocks. Each block gets a `_col`
// (its lane index) and `_totalCols` (number of lanes in its overlap cluster)
// so the timeline can render them side-by-side instead of stacking on top.
//
// Complexity: O(n log n) for the sort, O(n × max_overlap) for the sweep.
// In practice max_overlap is bounded by daily schedule density (~3-5),
// so this is effectively O(n). The naive alternative recomputing totalCols
// per block via a full filter would be O(n²).
export function assignTimelineColumns(blocks) {
  const sorted = [...blocks]
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
    .map((b) => ({ ...b }));
  const active = []; // { block, endMin } — blocks still overlapping with current

  for (const block of sorted) {
    const startMin = toMinutes(block.start);
    // Drop blocks that ended before this one started.
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].endMin <= startMin) active.splice(i, 1);
    }
    // Pick smallest free lane among currently-active blocks.
    const usedCols = new Set(active.map((a) => a.block._col));
    let col = 0;
    while (usedCols.has(col)) col++;
    block._col = col;
    // Compute shared totalCols = max lane index used by this block's cluster.
    let maxCol = col;
    for (const a of active) if (a.block._col > maxCol) maxCol = a.block._col;
    const totalCols = maxCol + 1;
    block._totalCols = totalCols;
    // All active blocks share the same cluster → same totalCols.
    for (const a of active) a.block._totalCols = totalCols;
    active.push({ block, endMin: toMinutes(block.end) });
  }

  return sorted;
}

export function getProtectedBreaks(settings) {
  // 显式设置的休息时段优先；未设置时按工作时段之间 >30min 的间隙推断（如午休）
  const explicit = Array.isArray(settings?.breaks) ? settings.breaks : [];
  if (explicit.length) {
    return explicit
      .filter((b) => b?.start && b?.end && toMinutes(b.end) > toMinutes(b.start))
      .map((b) => ({ start: b.start, end: b.end, title: b.title || "休息" }));
  }
  const segs = settings.workSegments || [];
  const breaks = [];
  for (let i = 0; i < segs.length - 1; i++) {
    const gapStart = segs[i].end;
    const gapEnd = segs[i + 1].start;
    if (toMinutes(gapEnd) - toMinutes(gapStart) >= 30) {
      breaks.push({ start: gapStart, end: gapEnd, title: "休息" });
    }
  }
  return breaks;
}

export function polishAiBlocks(blocks, segments) {
  if (!blocks.length || !segments.length) return blocks;
  const MIN_KEEP = 10;

  // detect split pairs: blocks sharing same taskId or title with -A/-B/-I/-II suffix
  const getBase = (title) => (title || "").replace(/[-_][ABIII]+$/, "").trim();
  const result = blocks.map((b) => ({ ...b }));

  for (let i = 0; i < result.length - 1; i++) {
    const a = result[i];
    const b = result[i + 1];
    if (a._drop || b._drop) continue;
    const sameTask = a.taskId && a.taskId === b.taskId;
    const sameBase = getBase(a.title) === getBase(b.title) && a.title !== b.title;
    if (!sameTask && !sameBase) continue;

    const aDur = toMinutes(a.end) - toMinutes(a.start);
    const bDur = toMinutes(b.end) - toMinutes(b.start);

    if (aDur < MIN_KEEP) {
      a._drop = true;
      b.start = a.start;
    }
    if (bDur < MIN_KEEP) {
      b._drop = true;
      if (!a._drop) a.end = b.end;
    }
  }

  // last segment tail: check if block near end of last segment
  const lastSeg = segments[segments.length - 1];
  const lastSegEnd = toMinutes(lastSeg.end);
  for (let i = result.length - 1; i >= 0; i--) {
    const b = result[i];
    if (b._drop) continue;
    const bEnd = toMinutes(b.end);
    const bDur = bEnd - toMinutes(b.start);
    if (bEnd <= lastSegEnd) {
      const remaining = lastSegEnd - bEnd;
      if (remaining > 0 && remaining < bDur) {
        // task ended, but the remaining gap after it is too small for the same task
        // → leave as-is, AI already handled
      }
    }
    break; // only check last block
  }

  // Safety net: even with the HARD BOUNDARY RULE in the prompt, AI may still
  // emit blocks outside work segments (weak models, temperature drift, JSON
  // truncation). Force-clamp start/end into the nearest segment and drop
  // anything that collapses below 5 min — those are too short to render or
  // interact with meaningfully.
  return clampToSegments(result, segments);
}

// Force every block to lie strictly within one of `segments`. Blocks that
// don't fit are clamped (start/end pulled into the nearest segment that
// contains the midpoint); if a block has no overlap with any segment, it's
// dropped. Blocks shorter than MIN_BLOCK_MIN after clamping are also dropped.
export function clampToSegments(blocks, segments) {
  const MIN_BLOCK_MIN = 5;
  if (!segments.length) return blocks.filter(() => false);
  const segRanges = segments.map((s) => ({ start: toMinutes(s.start), end: toMinutes(s.end) }));

  return blocks
    .filter((b) => b && b.start && b.end)
    .map((b) => {
      const sMin = toMinutes(b.start);
      const eMin = toMinutes(b.end);
      if (eMin <= sMin) return { ...b, _drop: true };
      // Find segment containing the block midpoint, or nearest one.
      const mid = (sMin + eMin) / 2;
      let seg = segRanges.find((s) => mid >= s.start && mid <= s.end);
      if (!seg) {
        // Pick nearest segment by midpoint distance.
        let best = segRanges[0];
        let bestDist = Math.abs(mid - (best.start + best.end) / 2);
        for (const s of segRanges) {
          const d = Math.abs(mid - (s.start + s.end) / 2);
          if (d < bestDist) { best = s; bestDist = d; }
        }
        seg = best;
      }
      const newStart = Math.max(sMin, seg.start);
      const newEnd = Math.min(eMin, seg.end);
      const newDur = newEnd - newStart;
      if (newDur < MIN_BLOCK_MIN) return { ...b, _drop: true };
      return { ...b, start: toTime(newStart), end: toTime(newEnd) };
    });
}

export function workloadMinutes(settings) {
  return (settings.workSegments || []).reduce((sum, seg) => sum + duration(seg.start, seg.end), 0);
}

export function getFreeIntervals(settings, fixedBlocks, options = {}) {
  const segments = settings.workSegments || [];
  if (!segments.length) return [];
  const fixed = sortBlocks(fixedBlocks).map((block) => ({
    start: toMinutes(block.start),
    end: toMinutes(block.end),
  }));
  const intervals = [];

  segments.forEach((seg) => {
    const segStart = toMinutes(seg.start);
    const segEnd = toMinutes(seg.end);
    let cursor = segStart;

    fixed.forEach((block) => {
      if (block.end <= segStart || block.start >= segEnd) return;
      if (block.start > cursor && block.start < segEnd) {
        intervals.push({ start: cursor, end: Math.min(block.start, segEnd), segment: seg });
      }
      cursor = Math.max(cursor, Math.min(block.end, segEnd));
    });

    if (cursor < segEnd) {
      intervals.push({ start: cursor, end: segEnd, segment: seg });
    }
  });

  const notBefore = typeof options.notBefore === "number" ? options.notBefore : null;
  return intervals
    .map((interval) => ({
      ...interval,
      start: notBefore !== null ? Math.max(interval.start, notBefore) : interval.start,
    }))
    .filter((interval) => interval.end > interval.start);
}


export function reconcileScheduleBlocks(blocks, settings, selectedDate) {
  const protectedBreaks = getProtectedBreaks(settings);
  const todayBlocks = sortBlocks(blocks.filter((block) => block.date === selectedDate));
  const busyBlocks = todayBlocks.filter((block) => block.type === "busy");
  const taskBlocks = todayBlocks.filter((block) => block.type !== "busy");
  const removedBlockIds = new Set();
  const removedTaskIds = new Set();

  function remove(block) {
    removedBlockIds.add(block.id);
    if (block.taskId) removedTaskIds.add(block.taskId);
  }

  taskBlocks.forEach((block) => {
    if (!isInsideWorkWindow(block, settings) || overlapsAny(block, protectedBreaks) || overlapsAny(block, busyBlocks)) {
      remove(block);
    }
  });

  taskBlocks.forEach((block, index) => {
    if (removedBlockIds.has(block.id)) return;
    taskBlocks.slice(index + 1).forEach((candidate) => {
      if (removedBlockIds.has(candidate.id) || !overlapsAny(block, [candidate])) return;
      remove(block);
      remove(candidate);
    });
  });

  return {
    blocks: blocks.filter((block) => !removedBlockIds.has(block.id)),
    removedTaskIds: [...removedTaskIds],
  };
}

export function isInsideWorkWindow(block, settings) {
  const segs = settings.workSegments || [];
  return segs.some((seg) => toMinutes(block.start) >= toMinutes(seg.start) && toMinutes(block.end) <= toMinutes(seg.end));
}

export function isBlockInsideIntervals(block, intervals) {
  const start = toMinutes(block.start);
  const end = toMinutes(block.end);
  return intervals.some((interval) => start >= interval.start && end <= interval.end);
}

export function normalizeScheduleQuestions(items, taskById) {
  const questions = (Array.isArray(items) ? items : [])
    .map((item) => ({
      id: uid("schedule-question"),
      taskId: String(item.taskId || ""),
      title: String(item.title || taskById[item.taskId]?.title || "需要确认的任务").trim(),
      estimateMinutes: Number(item.estimateMinutes || taskById[item.taskId]?.estimateMinutes || 30),
      reason: String(item.reason || "AI 不确定应该把它放在哪里。").trim(),
      hint: String(item.hint || "请补充时间约束，或在下方手动安排。").trim(),
    }))
    .filter((item) => item.title);

  return questions.filter(
    (item, index) =>
      questions.findIndex(
        (candidate) =>
          (item.taskId && candidate.taskId === item.taskId) ||
          (!item.taskId && !candidate.taskId && titlesReferToSameTask(candidate.title, item.title)),
      ) === index,
  );
}

export function normalizeAiScheduleResult(result, { tasks, existingBlocks, settings, selectedDate, notBefore }) {
  const todayBlocks = existingBlocks.filter((block) => block.date === selectedDate);
  const manualBlocks = todayBlocks.filter((block) => !block.auto);
  // 固定时间任务先钉到指定时间点，作为 AI 浮动排期的硬约束。
  const pinned = buildFixedTimeBlocks(tasks, settings, manualBlocks, selectedDate, { notBefore });
  const intervals = getFreeIntervals(settings, manualBlocks.concat(pinned.blocks), { notBefore });
  const adjustmentsByTaskId = new Map(
    (Array.isArray(result?.taskAdjustments) ? result.taskAdjustments : [])
      .filter((item) => item?.taskId)
      .map((item) => [String(item.taskId), item]),
  );
  const adjustedTasks = tasks.map((task) => {
    const adjustment = adjustmentsByTaskId.get(task.id);
    if (!adjustment) return task;
    const estimateMinutes = estimateMinutesForTitle(
      task.title,
      Math.max(10, Math.min(480, Number(adjustment.estimateMinutes) || task.estimateMinutes || 30)),
    );
    return estimateMinutes === Number(task.estimateMinutes) ? task : { ...task, estimateMinutes };
  });
  const taskById = Object.fromEntries(adjustedTasks.map((task) => [task.id, task]));
  const scheduledTaskIds = new Set(manualBlocks.map((block) => block.taskId).filter(Boolean));
  const autoBlocks = [];
  let questions = normalizeScheduleQuestions(result?.questions, taskById);

  (Array.isArray(result?.blocks) ? result.blocks : []).forEach((item) => {
    const taskId = String(item.taskId || "");
    const task = taskById[taskId];
    const start = String(item.start || "");
    const requestedEnd = String(item.end || "");
    if (!task || task.date !== selectedDate || task.status === "done" || task.fixedTime || task.kind === "fixed" || scheduledTaskIds.has(taskId)) return;
    if (isTicketPurchaseTask(task.title) && !parseTimeInSentence(task.title)) return;
    const meetingEnd = isPostMeetingTask(task.title) ? meetingEndForTask(task.title, manualBlocks) : null;
    if (isPostMeetingTask(task.title) && (!meetingEnd || toMinutes(start) < meetingEnd)) return;
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(requestedEnd) || toMinutes(requestedEnd) <= toMinutes(start)) return;
    const estimateMinutes = estimateMinutesForTitle(task.title, Number(task.estimateMinutes) || duration(start, requestedEnd));
    const end = toTime(toMinutes(start) + estimateMinutes);

    const block = {
      id: uid("block"),
      taskId,
      type: "task",
      date: selectedDate,
      title: String(item.title || ""),
      start,
      end,
      auto: true,
    };

    if (!isBlockInsideIntervals(block, intervals)) return;
    if (overlapsAny(block, manualBlocks.concat(pinned.blocks).concat(autoBlocks))) return;
    autoBlocks.push(block);
    scheduledTaskIds.add(taskId);
  });

  const scheduledTitles = manualBlocks
    .concat(autoBlocks)
    .map((block) => taskById[block.taskId]?.title || block.title)
    .filter(Boolean);
  questions = questions.filter((question) => {
    if (question.taskId && scheduledTaskIds.has(question.taskId)) return false;
    return !scheduledTitles.some((title) => titlesReferToSameTask(title, question.title));
  });

  const unscheduled = adjustedTasks.filter(
    (task) =>
      task.date === selectedDate &&
      task.status !== "done" &&
      !task.fixedTime &&
      task.kind !== "fixed" &&
      !scheduledTaskIds.has(task.id),
  );

  unscheduled.forEach((task) => {
    if (questions.some((question) => question.taskId === task.id || titlesReferToSameTask(question.title, task.title))) return;
    const ambiguousTicketPurchase = isTicketPurchaseTask(task.title) && !parseTimeInSentence(task.title);
    const missingMeeting = isPostMeetingTask(task.title) && !meetingEndForTask(task.title, manualBlocks);
    questions.push({
      id: uid("schedule-question"),
      taskId: task.id,
      title: task.title,
      estimateMinutes: Number(task.estimateMinutes) || 30,
      reason: ambiguousTicketPurchase
        ? "标题里的时间更像车次或出发时段，我还不知道你准备什么时候执行买票。"
        : missingMeeting
          ? "这是会后整理任务，但还没有找到对应会议的结束时间。"
          : "AI 没有为这个任务给出可靠时间块。",
      hint: ambiguousTicketPurchase
        ? "请先确认买票的执行时间或最晚完成时间，再放入手动表单。"
        : missingMeeting
          ? "请先补充会议时间，再安排到会后。"
          : "请补充时间约束，或手动指定它适合放在上午、下午、午休后还是某个固定事项前后。",
    });
  });

  pinned.conflicts.forEach((task) => {
    if (questions.some((question) => question.taskId === task.id)) return;
    questions.push({
      id: uid("schedule-question"),
      taskId: task.id,
      title: task.title,
      estimateMinutes: Number(task.estimateMinutes) || 30,
      reason: `固定时间 ${task.fixedStart} 与已有安排冲突，没能钉到该时间。`,
      hint: "请调整该任务时间，或先移开冲突的安排。",
    });
  });

  (pinned.expiredTaskIds || []).forEach((taskId) => {
    if (questions.some((question) => question.taskId === taskId)) return;
    const task = taskById[taskId];
    if (!task) return;
    questions.push({
      id: uid("schedule-question"),
      taskId,
      title: task.title,
      estimateMinutes: Number(task.estimateMinutes) || 30,
      reason: `固定时间 ${task.fixedStart} 已过，请确认是否顺延。`,
      hint: "请调整该任务时间，或确认顺延到之后的空档。",
    });
  });

  const reconciled = reconcileScheduleBlocks(
    existingBlocks
      .filter((block) => !(block.date === selectedDate && block.auto))
      .concat(autoBlocks),
    settings,
    selectedDate,
  );

  // 钉好的固定时间块不参与浮动 reconcile（避免被午休/工作时段裁掉），直接保留用户指定的时间。
  return {
    blocks: reconciled.blocks.concat(pinned.blocks),
    tasks: adjustedTasks,
    questions,
    message: result?.message || "",
  };
}

export function preparePlannerForScheduling({ tasks, blocks, settings, selectedDate }) {
  const compacted = compactPlannerTasks(tasks, blocks);
  const reconciled = reconcileScheduleBlocks(compacted.blocks, settings, selectedDate);

  return {
    tasks: compacted.tasks,
    blocks: reconciled.blocks,
    removedTaskIds: reconciled.removedTaskIds,
  };
}

// 把「固定时间任务」（fixedTime + fixedStart）钉到其指定时间点，作为排期硬约束。
// 返回钉好的时间块、已钉任务 id 集合，以及因冲突无法钉入的任务（交给上层变成待决问题）。
export function buildFixedTimeBlocks(tasks, settings, fixedBlocks, selectedDate, options = {}) {
  const blocks = [];
  const pinnedTaskIds = new Set();
  const conflicts = [];
  const expiredTaskIds = new Set();
  tasks
    .filter(
      (task) =>
        task.date === selectedDate &&
        task.status !== "done" &&
        task.fixedTime &&
        /^\d{2}:\d{2}$/.test(task.fixedStart || ""),
    )
    .sort((a, b) => toMinutes(a.fixedStart) - toMinutes(b.fixedStart))
    .forEach((task) => {
      // 已被手动放置的固定时间任务不再重复钉块。
      if (fixedBlocks.some((block) => block.taskId === task.id)) {
        pinnedTaskIds.add(task.id);
        return;
      }
      const estimate = Math.max(10, estimateMinutesForTitle(task.title, Number(task.estimateMinutes) || 30));
      const start = task.fixedStart;
      if (typeof options.notBefore === "number" && toMinutes(start) < options.notBefore) {
        expiredTaskIds.add(task.id);
        return;
      }
      const end = toTime(toMinutes(start) + estimate);
      const block = {
        id: uid("block"),
        taskId: task.id,
        type: "task",
        date: selectedDate,
        title: "",
        start,
        end,
        auto: true,
        fixedTime: true,
      };
      if (overlapsAny(block, fixedBlocks.concat(blocks))) {
        conflicts.push(task);
        return;
      }
      blocks.push(block);
      pinnedTaskIds.add(task.id);
    });
  return { blocks, pinnedTaskIds, conflicts, expiredTaskIds: [...expiredTaskIds] };
}

// 为单个任务找一个合理的时间槽（用于「待决问题」里点击「今日」时的放置），
// 而不是粗暴塞进当天第一个空档：固定时间→其时间点；会后整理→不早于会议结束；其余→跳过午休的首个可用空档。
export function findSlotForTask(task, settings, dayBlocks, selectedDate, options = {}) {
  const notBefore = typeof options.notBefore === "number" ? options.notBefore : null;
  const estimate = Math.max(10, estimateMinutesForTitle(task.title, Number(task.estimateMinutes) || 30));
  const sameDay = dayBlocks.filter((block) => block.date === selectedDate);

  if (task.fixedTime && /^\d{2}:\d{2}$/.test(task.fixedStart || "")) {
    const start = task.fixedStart;
    const end = toTime(toMinutes(start) + estimate);
    if (!overlapsAny({ start, end }, sameDay) && (notBefore === null || toMinutes(start) >= notBefore)) {
      return { start, end };
    }
  }

  const earliest = isPostMeetingTask(task.title)
    ? meetingEndForTask(task.title, sameDay.filter((block) => block.type === "busy"))
    : null;
  const intervals = getFreeIntervals(settings, sameDay.concat(getProtectedBreaks(settings)), { notBefore });
  for (const interval of intervals) {
    const start = Math.max(interval.start, earliest || interval.start);
    if (start + estimate <= interval.end) {
      return { start: toTime(start), end: toTime(start + estimate) };
    }
  }
  return null;
}

export function buildAutoBlocks({ tasks, existingBlocks, settings, selectedDate, notBefore }) {
  const todayBlocks = existingBlocks.filter((block) => block.date === selectedDate);
  const manualBlocks = todayBlocks.filter((block) => !block.auto);
  const scheduledTaskIds = new Set(manualBlocks.map((block) => block.taskId).filter(Boolean));
  const busyTaskTitles = new Set(
    manualBlocks
      .filter((block) => block.type === "busy")
      .map((block) => normalizeTitle(block.title)),
  );

  // 先把固定时间任务钉到指定时间点，作为浮动任务排期的硬约束。
  const pinned = buildFixedTimeBlocks(tasks, settings, manualBlocks, selectedDate, { notBefore });
  const candidates = tasks
    .filter((task) =>
      task.date === selectedDate &&
      task.status !== "done" &&
      !task.fixedTime &&
      task.kind !== "fixed" &&
      !scheduledTaskIds.has(task.id) &&
      !busyTaskTitles.has(normalizeTitle(task.title))
    )
    .sort(compareTasksForScheduling)
    .map((task) => {
      const postMeeting = isPostMeetingTask(task.title);
      const meetingEnd = postMeeting ? meetingEndForTask(task.title, manualBlocks) : null;
      const ambiguousTicketPurchase = isTicketPurchaseTask(task.title) && !parseTimeInSentence(task.title);
      const earliestBase = postMeeting && meetingEnd ? meetingEnd : toMinutes((settings.workSegments || [{ start: "09:00" }])[0].start);
      const earliestStart = typeof notBefore === "number" ? Math.max(earliestBase, notBefore) : earliestBase;

      return {
        ...task,
        placementReason: ambiguousTicketPurchase
          ? "这像是买票任务，但标题里的时间更可能是车次/出发时间，不是你打算买票的执行时间。"
          : postMeeting ? "看起来是会后整理或后续行动，但我没找到对应会议时间。" : "",
        placementHint: ambiguousTicketPurchase
          ? "请告诉我你准备什么时候买票，或最晚几点前必须买好，再手动放入时间块。"
          : postMeeting ? "请先添加会议的不可用时间块，或手动指定这个任务的开始时间。" : "",
        needsPlacement: (postMeeting && !meetingEnd) || ambiguousTicketPurchase,
        earliestStart,
      };
    });

  const intervals = getFreeIntervals(settings, manualBlocks.concat(pinned.blocks), { notBefore });
  const autoBlocks = [];
  const questions = candidates
    .filter((task) => task.needsPlacement)
    .map((task) => ({
      id: uid("schedule-question"),
      taskId: task.id,
      title: task.title,
      estimateMinutes: Number(task.estimateMinutes) || 30,
      reason: task.placementReason,
      hint: task.placementHint,
    }));
  const unscheduled = candidates.filter((task) => !task.needsPlacement);

  intervals.forEach((interval) => {
    let cursor = interval.start;

    while (unscheduled.length > 0 && cursor < interval.end) {
      const taskIndex = unscheduled.findIndex((task) => {
        const estimate = Number(task.estimateMinutes) || 30;
        const start = Math.max(cursor, task.earliestStart || interval.start);
        return start + estimate <= interval.end;
      });

      if (taskIndex < 0) break;

      const task = unscheduled.splice(taskIndex, 1)[0];
      const estimate = Number(task.estimateMinutes) || 30;
      const start = Math.max(cursor, task.earliestStart || interval.start);
      const end = start + estimate;
      const tasksBefore = autoBlocks.filter((b) => b.type === "task").length;

      autoBlocks.push({
        id: uid("block"),
        taskId: task.id,
        type: "task",
        date: selectedDate,
        start: toTime(start),
        end: toTime(end),
        auto: true,
      });
      cursor = end + Number(tasksBefore % 2 === 0 ? (settings.shortBreak || 10) : (settings.longBreak || 30));
    }
  });

  unscheduled.forEach((task) => {
    questions.push({
      id: uid("schedule-question"),
      taskId: task.id,
      title: task.title,
      estimateMinutes: Number(task.estimateMinutes) || 30,
      reason: "当前固定安排和工作时间里没有足够连续空档。",
      hint: "可以拆小、延期，或在下方手动安排到你觉得合适的位置。",
    });
  });

  pinned.conflicts.forEach((task) => {
    questions.push({
      id: uid("schedule-question"),
      taskId: task.id,
      title: task.title,
      estimateMinutes: Number(task.estimateMinutes) || 30,
      reason: `固定时间 ${task.fixedStart} 与已有安排冲突，没能钉到该时间。`,
      hint: "请调整该任务时间，或先移开冲突的安排。",
    });
  });

  (pinned.expiredTaskIds || []).forEach((taskId) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    questions.push({
      id: uid("schedule-question"),
      taskId,
      title: task.title,
      estimateMinutes: Number(task.estimateMinutes) || 30,
      reason: `固定时间 ${task.fixedStart} 已过，请确认是否顺延。`,
      hint: "请调整该任务时间，或确认顺延到之后的空档。",
    });
  });

  const reconciled = reconcileScheduleBlocks(
    existingBlocks
      .filter((block) => !(block.date === selectedDate && block.auto))
      .concat(autoBlocks),
    settings,
    selectedDate,
  );

  // 钉好的固定时间块不参与上面的浮动 reconcile（避免被午休/工作时段裁掉），直接保留用户指定的时间。
  return {
    blocks: reconciled.blocks.concat(pinned.blocks),
    questions,
  };
}
