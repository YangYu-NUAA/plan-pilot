# 故障排查：AI 网络错误与文件同步

> 常见症状：目标拆解、今日建议或规划访谈提示 `Failed to fetch`、「本地 API 代理不可达」或「内嵌本地服务未响应」；也可能出现可关闭的文件同步警告。

## 先按平台定位

同一个提示在不同平台上的请求链路不同，不要混用排查方法。

| 平台 | AI 请求链路 | 计划数据 | 网络层失败时先检查 |
|---|---|---|---|
| **Web 浏览器** | 浏览器 → `/api/ai/chat` → 本地服务 → AI 服务商 | localStorage + `/api/data` 文件同步 | 本地服务是否仍在运行、是否正在重启 |
| **Android（Capacitor）** | `CapacitorHttp` → AI 服务商，不经过本地代理 | 仅 localStorage，不请求 `/api/data` | 设备网络、服务商地址与协议 |
| **Electron 桌面应用** | 渲染进程 → 随机回环端口上的内嵌服务 → AI 服务商 | 应用本地存储 + 内嵌服务写入应用数据目录 | 完全退出并重新打开 Plan Pilot；不要按 Web 方式另起服务 |

### Web

```text
浏览器 (fetch /api/ai/chat)
  → vite.config.js 注册的 local-api-proxy 中间件
  → server/dataProxy.js 的 createApiHandler
  → AI 服务商（OpenAI-compatible 或 Anthropic Messages）
```

- 确认启动本地服务的终端仍在运行；开发模式使用 `npm run dev`，自行配置的 `startup.bat` 也属于这一平台。
- 页面仍显示不代表服务仍可用：浏览器可能保留了旧标签页，而终端已经关闭或服务正在重启。
- 端口被占用时，以终端实际输出的 Local 地址为准。

### Android

- `src/ai/directAi.js` 使用原生 HTTP 直连服务商，以绕过 WebView CORS；没有本地 Vite/Node 代理需要启动。
- 「网络不可达」主要表示设备到服务商之间失败。检查网络、基地址、协议和服务商可访问性，而不是检查电脑上的开发服务器。
- 计划数据只写 localStorage，因此没有 Web/Electron 的文件同步警告条。

### Electron

```text
应用窗口 (fetch /api/ai/chat)
  → electron/main.js 启动的 127.0.0.1:<随机端口> 内嵌服务器
  → server/dataProxy.js 的 createApiHandler
  → AI 服务商
```

- 内嵌服务器随应用启动，不需要也不应依赖外部终端。出现「Plan Pilot 内嵌本地服务未响应」时，先完全退出再重新打开应用。
- 数据默认写入应用 userData 下的 `data/`；开发隔离可用 `PLAN_PILOT_USER_DATA_DIR` / `PLAN_PILOT_DATA_DIR`，详见 `docs/macos.md`。
- AI Key 由 `electron/secureCredentialStore.js` 和系统安全存储处理。钥匙串锁定或权限问题与网络代理故障是两回事，应分别根据设置中的存储状态和 AI 响应状态码排查。

## 公共代理实现

Web 与 Electron 的 `/api/data`、`/api/profile`、`/api/ai/status`、`/api/ai/chat` 和 `/api/asr` 都使用 **`server/dataProxy.js`** 中的 `createApiHandler`：

- `vite.config.js` 只负责把公共处理器注册到 Vite dev/preview server。
- `electron/main.js` 只负责创建内嵌 HTTP 服务、静态文件服务和桌面生命周期。
- 上游 60 秒超时、请求体上限、协议转换、环境变量 Key 读取及网络错误翻译均以 `server/dataProxy.js` 为准。

## 错误分类与处理

| 场景 | 前端表现 | 处理建议 |
|---|---|---|
| 浏览器到 Web 本地代理无响应 | 「本地 API 代理不可达」；不再盲目重试或建议换模型 | 按 Web 一节恢复本地服务 |
| Android 原生 HTTP 无响应 | 「网络不可达」 | 检查设备网络与服务商地址 |
| Electron 到内嵌服务无响应 | 「Plan Pilot 内嵌本地服务未响应」 | 重启应用；持续失败再检查应用数据目录与运行日志 |
| 上游域名不可达、断网或地址错误 | 通常为 `(500)`，公共代理会返回更具体的网络原因 | 检查上游 baseUrl、DNS、代理与防火墙 |
| 上游超过 60 秒 | `(500)` 超时/中止信息 | 换更快的模型，或调整 `server/dataProxy.js` 的上游超时 |
| 未配置 API Key | 未配置提示或 `(400) Missing AI API key.` | 在设置中添加 Key，或配置对应平台的服务端环境变量 |
| Key 无效、模型名不存在 | `(401/404)` 及上游原因 | 按上游提示修正 Key、模型名或地址 |

`src/ai/callPlanningAi.js` 将传输层异常包装为带 `fatal=true` 的错误，停止后续 JSON 修复重试；原始异常保存在 `error.cause`，便于调试。HTTP 401/404 等配置错误同样是 fatal，但保留上游状态与原因。

## 文件同步警告与首次加载保护

Web 和 Electron 的 `usePlannerStore` 会在首次 GET 失败时进行最多 3 次尝试；重试间隔为 3 秒：

1. **重试期间不解锁保存**：不会因旧 localStorage 状态提前发送 POST，也不会提前显示最终失败警告。
2. **文件有数据**：成功水合后才允许后续保存。
3. **文件为空且有 localStorage**：先等待初始化 POST 完成，再解锁后续保存；所有文件 POST 进入同一串行队列，避免初始化写入与后续保存竞争覆盖。
4. **最终 GET 失败**：显示同步警告并允许继续使用本地数据；后续保存仍会尝试，以便服务恢复后自动同步。
5. **警告可关闭、恢复会清状态**：关闭只隐藏当前提示；成功的 GET/POST 会清除 `syncIssue`，App 随后重置关闭标记，下一次故障仍可提示。保存失败会重新显示问题。

这些时序由 `src/hooks/plannerSyncController.js` 协调，回归测试在 `test/plannerSyncController.test.mjs`，使用可控 fetch 与定时器，不需要浏览器或大型测试依赖。

## 相关文件

- `server/dataProxy.js` — Web/Electron 共用的数据与 AI/ASR API 实现
- `vite.config.js` — Web 中间件注册
- `electron/main.js` — Electron 内嵌服务器与桌面生命周期
- `src/app/platform.js` / `src/app/platformMessages.js` — 平台检测与分流文案
- `src/ai/callPlanningAi.js` / `src/ai/directAi.js` — 代理调用与 Android 直连
- `src/hooks/usePlannerStore.js` / `src/hooks/plannerSyncController.js` — 水合、重试、同步健康状态与串行保存
- `src/App.jsx` / `src/styles.css` — 可关闭的同步警告条
