# 规划访谈（Coach）LLM Harness 重设计方案

> 状态：草稿 / 实施中。本文件是「先设计后实现」的活文档，可逐条批注后再细化。
> 决策：步骤 3 采用 **方案 B（单次调用 + 显式动作 schema）**，方案 A（解耦两次调用）留作升级。

## 1. 要解决的问题（代码层面）

当前 `runPlanningCoach` 每轮只发 **一次** `callPlanningAi`，让模型在同一次调用里同时「对话 + 判 phase + 吐 `items[]`」，且 app 侧 **不保留任何跨轮状态**（只把最新 `items` 覆盖进 `suggestions`）。弱模型于是停在 clarify、把方案写进 `message` 文字、`items` 为空 → 用户「看不到建议、不落成目标」。

目标行为：
- app 侧维护跨轮累积的 **草稿** `coach.draft`（goals/tasks/busy），模型每轮只提 **增量**，app 负责合并/去重；草稿是权威来源。
- 落一条目标 = 一个 **显式动作**（`add_goal` / `add_task` / `add_busy` / `ask` / `done`），而非埋在大 JSON 数组里被跳过。
- 长期 / 月度访谈由 app 用 **区域 checklist** 确定性地带模型逐个方向问。
- 模型若声称完成却没产出，**自校验后重试一次**。
- UI 实时显示草稿（可逐条删），「加入计划」把草稿落库。

## 2. 会影响的模块 / 文件

- `src/coachHarness.js`（新增，纯函数，可单测）：`emptyDraft` / `mergeCoachDraft` / `draftCount` / `seedAgendaAreas` / `looksLikeFinalizeIntent` / `shouldForceProposeRetry` / `normalizeKey`。配 `test/coachHarness.test.mjs`。
- `src/App.jsx`：重写 `runPlanningCoach`（方案 B 单次动作 schema + 草稿合并 + agenda 推进 + 自校验）；`planningCoach` state 加 `draft`、`agenda`；`acceptPlanningCoachSuggestions` 改为落 `coach.draft`（复用 tempId→realId 的 `resolveGoalReference`）；访谈 UI 渲染草稿 + 区域进度。
- `src/planningSkill.js`：把教练提示改成「动作 schema」版（asker 行为内联其中）；`planningCoachStartMessage` 配合 agenda 微调。
- `callPlanningAi`：不改签名（#27 后显式传 apiKey），仅复用。
- 复用不改：`collectCoachItems` / `normalizeCoachItems` / `filterCoachItems`（解析 + 落库去重）。
- 注意：`planningCoach` 非持久化（`planner` 才持久化），草稿刷新即丢——UI 需提示；是否纳入持久化属另一改动，不在本次范围。

## 3. 步骤拆解（一步一验，可回退）

1. **纯函数 + 草稿/agenda state（零行为变化）**：新增 `coachHarness.js` + 测试；`planningCoach` 加 `draft`/`agenda`；shim 把现有单次 `items` 也并进 `draft`（UI 仍读旧 `suggestions`）。
2. **动作 schema 提示**：`planningSkill.js` 改成让模型每轮返回 `{message, done, actions:[{type,...}]}`；暂不接线或与旧解析并存。
3. **重写 `runPlanningCoach`（方案 B）**：单次调用 → 解析 actions → 应用 add_* 到草稿 → ask 当 message → done 收尾。
4. **UI 实时草稿**：渲染 `coach.draft`（目标/任务/固定分组、逐条删）+ agenda 进度；`accept` 落草稿。
5. **区域 checklist + 自校验重试**：`seedAgendaAreas` 种子、`advanceAgenda` 推进、`shouldForceProposeRetry` 兜底。

## 4. 每一步怎么验证

- 纯函数（1、5）：`test/coachHarness.test.mjs` 覆盖去重（8 个不同研究目标不被合并、同名被合并）、区域切分（中文枚举 → 区域）、收尾意图谓词。`npm test`。
- 2/3/4：`npm run build` + `npm test` 全绿；用 **构造的假模型返回** 单测动作应用与草稿合并，不依赖真模型。
- 端到端模型行为：**无便宜的自动验证**（CI 跑不了真 LLM、本机浏览器预览被墙）。需作者重启 dev server、选「长期」手测那段实录。如实标注，不假装验证。

## 5. 最容易出错的地方

- 去重过松会把多个不同研究目标误并 → 草稿用 **精确归一标题** 去重（非模糊 `titleLooksDuplicate`）。
- tempId→realId 父子映射：落草稿时若丢 `resolveGoalReference`，目标会丢层级 / 父目标。
- agenda 种子从中文自由文本切方向很糊；切歪兜底到「按既有目标推断 + 默认分类」。
- 自校验重试封顶一次，防 done-but-empty 反复触发 / 重复落条目。
- 草稿不持久化，刷新即丢——UI 提示。
- today scope 保持单次现有行为，别被新管线带歪。
- 方案 B 仍是单模型决策，弱模型可能仍偏向只 `ask`；动作化 + 自校验是两道保险，若实测仍不稳再升级方案 A（解耦 extractor/asker 两调）。
