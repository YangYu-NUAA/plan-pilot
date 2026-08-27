# 自动排期：任务块必须排在当前时间之后

日期：2026-08-26

## 目标

「自动安排」产出的任务块起点不得早于用户点击排程时的“当前时间”；当天内已经过时的固定时间任务（`fixedTime` 且 `fixedStart` 已过去、尚未完成）改为转成待确认问题，而不是硬排。

## 范围与边界

- 仅对**今天**的排程生效（`selectedDate === today`）。排未来日期天然在现在之后，不受影响；排过去日期不引入该下限，避免浏览旧日程被误伤。
- “当前时间”在每次点击「自动安排」时计算一次并冻结，供预览与确认使用（避免预览过程中时间漂移）。
- 手动非固定时间块、未过时的固定块，本次一律不动。
- 若“现在”已晚于当天全部工作时段，当天任务全部转成待确认问题——这是符合要求的自然结果。

## 改动点（集中在调度层）

### `src/planner/scheduling.js`

1. `getFreeIntervals(settings, fixedBlocks, options)`：读取 `options.notBefore`（分钟数）。某工作时段内可分配区间的结束时间 `<= notBefore` 时整体排除；否则把区间起点抬到 `Math.max(interval.start, notBefore)`。
2. `buildFixedTimeBlocks(tasks, settings, fixedBlocks, selectedDate, options)`：读取 `options.notBefore`；对 `fixedTime` 且 `fixedStart`（分钟） `< notBefore` 且未完成的任务，加入返回的 `expiredTaskIds`。返回对象增加 `expiredTaskIds`。
3. `buildAutoBlocks`：把 `notBefore` 传入 `getFreeIntervals` 与 `buildFixedTimeBlocks`；候选任务的 `earliestStart` 与 `notBefore` 取较大值；`expiredTaskIds` 追加为待确认问题（reason「固定时间 HH:MM 已过，请确认是否顺延」，hint「请调整时间或确认顺延」）。
4. `normalizeAiScheduleResult`：同样把 `notBefore` 传入 `getFreeIntervals` 与 `buildFixedTimeBlocks`；`expiredTaskIds` 转成待确认问题。
5. `findSlotForTask`：新增 `notBefore` 参数，作为起点下限，保证手动“待确认问题 → 今日”快速放置也不会落到过去。

### `src/App.jsx`

1. `autoSchedule()` 开头计算 `scheduleNow`（HH:MM）与 `notBefore`（仅当天为分钟数，否则 `null`）。
2. `buildRulePreview` 与 AI 路径传入 `notBefore`（给 `buildAutoBlocks` / `normalizeAiScheduleResult`）。
3. AI 提示词新增规则：今天所有块不得早于当前时间（`<HH:MM>`）；已过时的固定时间任务返回一条 question 请用户确认，而不是硬排。
4. 发送给模型的 payload 增加 `now: scheduleNow`。

## 不改变

- AI 的其余排期语义（依赖、优先级、分段、会后等）。
- 规则排期的排序与贪心逻辑（只加“现在”下限）。
- 手动放置的冲突/重叠判定。

## 测试

- 规则路径：给当天配置工作时段，把“现在”设到时段中，断言自动块全部 `>= notBefore`。
- 固定块过期：存在 `fixedTime` 且 `fixedStart` 在过去的任务时，产物中包含对应待确认问题，且不生成该任务块。
- 未来日期：传入未来 `selectedDate` 时 `notBefore` 为 `null`，不加限制。
