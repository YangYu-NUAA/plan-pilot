# 故障排查：AI 报错「Failed to fetch」

> 症状：AI 规则访谈（或今日建议 / 目标拆解）报错
> `Failed to fetch（已自动重试，仍未拿到可用 JSON；可换更稳的模型如 DeepSeek）`

## 一句话结论

**这不是 AI 上游（DeepSeek 等）的错误**，而是浏览器 → 本地 Vite 代理之间在 HTTP 层就没拿到响应——
`Failed to fetch` 是浏览器对"连接被拒 / 连接被重置 / 请求从未完成"的统一网络层报错。
真正的原因几乎都是：**dev server 没在运行，或正在重启**。

（2026-08-27 起该错误已改为明确提示「本地 API 代理不可达：请先启动服务」，不再出现误导性的"换更稳的模型"建议；本文档保留完整分析供排查。）

## 请求链路

```
浏览器 (fetch /api/ai/chat)
  → Vite dev server 的 local-api-proxy 中间件 (vite.config.js)
    → 上游 AI 服务商（OpenAI-compatible 或 Anthropic Messages）
```

- 前端入口：`src/ai/callPlanningAi.js` → `POST /api/ai/chat`
- 代理：`vite.config.js` 中 `local-api-proxy` 插件（`configureServer` / `configurePreviewServer`）
- 关键参数：上游 60 秒超时（AbortController）、请求体 5MB 上限（`readBody`）、API Key 来源（请求体 → 环境变量 `AI_API_KEY` / `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY`）

## 失败模式 → 报错文案对照（实测）

| 场景 | 代理实际返回 | 前端看到的报错 | 处理建议 |
|---|---|---|---|
| **dev server 未运行 / 正在重启** | 无响应（连接被拒/重置） | `本地 API 代理不可达：dev server 未运行或正在重启…`（旧版为 `Failed to fetch（已自动重试…）`） | 启动服务：`startup.bat` 或 `npm run dev` |
| 上游域名不可达 / 断网 / 地址错误 | `500 {"error":"fetch failed"}` | `(500) fetch failed（已自动重试…）` | 检查网络、上游 baseUrl |
| 上游响应超过 60 秒 | `500 {"error":"This operation was aborted"}` | `(500) This operation was aborted…` | 换更快的模型，或调大 `vite.config.js` 的 60s 超时 |
| 任何层无 API Key | `400 {"error":"Missing AI API key."}` | `(400) Missing AI API key.` | 设置里填浏览器 Key，或配置服务端环境变量 |
| Key 无效 / 模型名不存在 / 地址错误 | 上游 401/404 透传 | `(401/404) <上游原因>` | 按上游提示修正 Key / 模型名 |
| 请求体 > 5MB | 连接被销毁 | 曾表现为 `Failed to fetch` | 正常数据远达不到（全部数据仅几十 KB），除非任务标题/规划文本被粘贴了超大内容 |

## 排查步骤

1. **看报错文案**：含「本地 API 代理不可达」→ 直接启动服务即可（最小化窗口里的 server 可能被误关、或电脑重启后浏览器标签恢复了但服务没起）。
2. **`(500) fetch failed`** → 上游网络问题：检查能否访问上游 baseUrl、是否有代理/防火墙拦截 node 进程。
3. **`(500) This operation was aborted`** → 上游太慢：推理型模型（如 step-3.7-flash）思考耗时可能超过 60s 代理超时，换快速模型或调大超时。
4. **`(401/404)`** → 配置问题：Key 或模型名，按上游原话修正。
5. **页面打开但 AI 全部失败、其他功能正常**：这是本应用的一个已知"静默陷阱"——`/api/data` 同步失败过去被静默吞掉（已修复，见下），localStorage 让应用照常工作，只有 AI 调用暴露服务掉线。

## 已实施的修复（2026-08-27）

1. **网络层错误明确化**（`src/ai/callPlanningAi.js`）：`fetch` 抛出的网络层错误（TypeError）转成可行动的提示「本地 API 代理不可达：dev server 未运行或正在重启，请先启动服务」，标记 `fatal` 直接失败、不再做三次注定失败的重试；原始错误保留在 `cause`。
2. **文件同步失败可见**（`src/hooks/usePlannerStore.js` + `src/App.jsx` + `src/styles.css`）：store 新增 `syncIssue`，顶栏下方渲染可关闭的警告条（数据暂存于浏览器、AI 与文件同步不可用）；服务恢复后自动消失；挂载加载失败先重试 3 次（间隔 3s，适配 `startup.bat` 等 60s 启动窗口）再提示。
3. **测试**：新增 2 个网络层错误单测（`test/callPlanningAi.test.mjs`）；Playwright E2E 验证了"服务正常无警告 / 服务掉线出警告 / 掉线时访谈报明确错误"三个场景。

## 相关文件

- `vite.config.js` — `local-api-proxy` 插件（转发、超时、请求体上限、Key 读取）
- `src/ai/callPlanningAi.js` — 前端 AI 调用与错误分类
- `src/hooks/usePlannerStore.js` — 持久化与同步健康状态
- `src/App.jsx` — 同步警告条渲染
