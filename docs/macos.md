# Plan Pilot · macOS 版使用指南

Electron 原生壳：同一个本地服务器（`server/dataProxy.js`，与 vite dev server 共用一份逻辑）跑在 App 进程内，窗口加载 `http://127.0.0.1:<随机端口>`。**数据存 JSON 文件、AI/语音经服务器代理**——与网页版行为完全一致，但不再需要终端里跑 `npm run dev`。

## 架构

| 能力 | 实现 |
|---|---|
| Web 资源 | `dist/` 打进 App（asar），静态文件由内嵌 http server 提供 |
| 数据持久化 | `~/Library/Application Support/Plan Pilot/data/`（JSON 文件，与网页版同构，可直接互拷） |
| AI / 语音代理 | 内嵌 server 转发，设置里的 Key 仅随对应请求临时传入 |
| Key 安全存储 | Electron `safeStorage` 调用 macOS 钥匙串加密；密文存 `secure-credentials.json`（权限 `0600`），重启自动读取，不受随机端口影响 |
| 麦克风 | `127.0.0.1` 是安全上下文 + `setPermissionRequestHandler` 放行 media |

## 构建

```bash
npm install
npm run mac:build        # = npm run build + electron-builder --mac (arm64 dmg)
# 产物：release/Plan Pilot-<版本>-arm64.dmg
```

需 Electron 二进制下载走代理时：`export HTTPS_PROXY=... ELECTRON_GET_USE_PROXY=1`。

开发调试（不打包）：`npm run electron:dev`。数据目录可用 `PLAN_PILOT_DATA_DIR` 覆盖；自动化测试需要完全隔离的 profile 时，可同时设置 `PLAN_PILOT_USER_DATA_DIR`（会影响 Key 密文与 Web 本地数据的位置）。

## 从网页版迁移

网页版（dev server）的数据在项目 `data/` 目录；App 的在 `~/Library/Application Support/Plan Pilot/data/`。迁移 = 整目录拷贝：

```bash
mkdir -p ~/Library/Application\ Support/Plan\ Pilot
cp -R <项目路径>/data ~/Library/Application\ Support/Plan\ Pilot/data
```

网页版的 API Key 不会随计划 JSON 一起迁移。首次使用桌面版时在设置中填写一次即可；此后聊天与语音 Key 均由 macOS 钥匙串加密保存，重启 App 不需要重填。清空本地数据会同时移除这两把 Key。

若系统钥匙串被锁定或拒绝访问，设置页会显示保存失败；此时输入只保留在当前窗口，不会静默降级为明文文件。
