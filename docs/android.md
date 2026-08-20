# Plan Pilot · Android 原生壳使用指南

把 Plan Pilot 作为原生 App 装进 Android 手机：数据只存本机（localStorage），AI 语音与对话通过 Capacitor 原生 HTTP 直连供应商（绕过 WebView CORS），无需任何后端服务器。

## 架构要点

| 能力 | 浏览器/桌面 | Android 原生壳 |
|---|---|---|
| 数据持久化 | localStorage + dev server 文件 | 纯 localStorage（自动检测，跳过 /api/data） |
| AI 对话 | /api/ai/chat 代理 | CapacitorHttp 直连（`src/ai/directAi.js`） |
| 语音识别 | /api/asr 代理 | Step Plan SSE 直连（`transcribeStepPlanDirect`） |
| 服务器 Key | 环境变量 | 设备本地 Key（设置里填，localStorage） |

原生检测在 `src/app/platform.js`（`Capacitor.isNativePlatform()`）。

## 构建 APK

需要 **JDK 21**（Capacitor 8 硬性要求，JDK 17 会报 `invalid source release: 21`）与 Android SDK（cmdline-tools + platform-36 + build-tools 35/36）。无 Android Studio 的最小命令行路径（本机已验证）：

```bash
# 1) Temurin JDK 21 + Google cmdline-tools 解压到 ~/jdk21 与 ~/android-sdk
# 2) sdkmanager --sdk_root=~/android-sdk --licenses 接受证书，
#    安装 platforms;android-36 与 build-tools;35.0.0
export JAVA_HOME=~/jdk21/Contents/Home
export ANDROID_HOME=~/android-sdk

npm install            # 已含 @capacitor/core / cli / android
npm run build          # 产出 dist/
npx cap sync android   # 同步 web 资源与配置到 android/
cd android && ./gradlew assembleDebug
# APK 在 android/app/build/outputs/apk/debug/app-debug.apk
```

发布版（自己签名）：

```bash
cd android && ./gradlew assembleRelease
```

## 首次使用

1. 手机允许「安装未知来源应用」，拷入 APK 安装
2. 打开 App → 设置（齿轮）→ 服务商选阶跃星辰，填 **聊天 API Key**（存设备 localStorage）
3. 语音：设置里「语音 ASR Key」填同一把（或独立 Key）；ASR 地址必须是 `https://api.stepfun.com/step_plan/v1`（Step Plan 套餐直连路径）
4. 麦克风权限在首次点语音按钮时由系统弹出

## 与桌面版的关系

- 数据不互通（各自 localStorage）。需要迁移时：桌面端「导出 JSON」→ 手机端设置里「导入 JSON」
- 代码同一份：`isNative` 分支决定走代理还是直连，Web 端行为完全不受影响
