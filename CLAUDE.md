# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

计划引航（Plan Pilot）是一个本地优先的引导式任务录入、目标拆解和自动时间规划工具。纯前端 React 应用，数据存储在浏览器 localStorage 及文件系统（通过 Vite API 代理），无账号系统，无云端数据库。

## 常用命令

```bash
npm install          # 安装依赖
npm run dev          # 开发服务器 (Vite，监听 127.0.0.1:5173)
npm run build        # 生产构建
npm run preview      # 预览生产构建
```

没有测试、lint 或类型检查脚本。

## 技术架构

- **React 18** (纯 JavaScript/JSX，无 TypeScript)
- **Vite 6** 作为构建工具，`@vitejs/plugin-react`
- **lucide-react** 是唯一第三方 UI 依赖
- **localStorage** 持久化，计划数据 key 为 `personal-planning-coach-v1`，浏览器本地 API Key 使用独立 key `plan-pilot-ai-api-key-v1`；计划数据同时通过 `POST /api/data` 同步到文件系统
- **PWA**：public/ 目录下有 manifest 和 service worker，仅 production 启用；只缓存静态资源，不缓存 `/api/*`
- 无路由库 — 三个视图（今日/目标/复盘）通过 `activeView` 状态切换

## 源文件结构

```
src/
├── App.jsx       # 整个应用逻辑（~4300 行），单文件架构
├── main.jsx      # ReactDOM 入口 + service worker 注册
└── styles.css    # 全局样式
vite.config.js    # Vite 配置 + 自定义 API 代理中间件 + 文件持久化
```

## 关键架构决策

### API 代理 (`vite.config.js` 中 `local-api-proxy` 插件)

Vite 自定义插件 `local-api-proxy` 处理以下路由：
- `POST /api/ai/chat` — 转发 AI 请求到外部服务商
- `GET/POST /api/data` — 文件系统读写（作为 localStorage 的持久化后端）
- `GET/POST/DELETE /api/profile` — 用户画像读写与清理
- `GET /api/ai/status` — AI Key 配置状态检查

AI 代理支持两种协议：
- **OpenAI-compatible**：大多数服务商，请求 `/chat/completions`
- **Anthropic Messages**：仅 Claude/Opus，请求 `/v1/messages`

代理处理两种协议的格式转换（OpenAI ↔ Anthropic），DeepSeek 的 thinking 参数透传，以及 Anthropic 响应的统一化。API Key 从前端请求体传入，或从环境变量 `AI_API_KEY` / `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` 读取。

### 数据模型 (`App.jsx:177-196`)

`defaultState` 定义了完整数据结构：
- `settings`: 工作时间区间和任务间隔
- `ai`: AI 配置（服务商、协议、模型、地址、是否允许复盘画像学习；不包含 Key）
- `goals[]`: 目标列表（long/month/week，status: active/paused/done）
- `tasks[]`: 任务列表（关联日期、目标、优先级、预估时间）
- `blocks[]`: 时间块列表（type: task/busy，可手动、自动或由周期安排派生；周期派生块不会写入磁盘）
- `dayPlans{}`: 按日期的晨间规划（固定安排、今日重点、精力等）
- `reviews[]`: 复盘记录
- `recurring[]`: 周期安排（固定每周重复的 busy 时间块）

所有状态通过 `usePlannerStore`（本质是 `useState` + `useEffect` 写入 localStorage 并同步到文件系统）管理。状态更新通过 `patchPlanner` 函数，不可变方式合并。

### 自动排期算法 (`App.jsx:1315-1410`)

`buildAutoBlocks` 函数实现：
1. 过滤当天未完成且未手动安排的任务
2. 按优先级排序（high > medium > low），考虑依赖关系和紧急程度
3. 会后整理任务（`isPostMeetingTask`）需要找到对应会议结束时间
4. 在工作时间和不可用时间块之间的空闲区间中，按优先级填充任务
5. 无法安排的任务返回为 `questions`（需用户手动决定）

### AI 集成

三个 AI 功能入口均在 App.jsx 中：
- **`generateBreakdown`**：目标拆解，AI 失败时回退到规则拆解（`makeBreakdown`）
- **`generateTodayAiGuide`**：今日任务建议
- **`runPlanningCoach`**：多轮规划访谈，AI 可追问缺失信息

所有 AI 调用经 `callPlanningAi` 统一处理，通过 `/api/ai/chat` 代理转发。JSON 响应从 markdown 代码块或原始文本中提取。

### 去重逻辑

`mergeDuplicateTasks` 在任务添加和导入时运行，按 `date|normalizedTitle` 去重。偏好保留手动任务和已完成状态。目标通过 `goalIdentity`（parentId|type|normalizedTitle）去重。

## 语言

UI 文案为简体中文。AI prompt 中系统指令为英文（避免模型输出语言偏移），用户上下文为中文。
