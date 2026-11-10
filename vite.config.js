import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

import { createApiHandler } from "./server/dataProxy.js";

// 本地 API（数据持久化 + AI/ASR 代理）的实现已抽到 server/dataProxy.js，
// 与 Electron macOS 壳（electron/main.js）共用同一份逻辑。
function dataProxy() {
  const handler = createApiHandler({ dataDir: path.resolve("data") });

  return {
    name: "local-api-proxy",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), dataProxy()],
});
