import { test } from "node:test";
import assert from "node:assert/strict";

import { getAiNetworkErrorMessage, getFileSyncIssueText } from "../src/app/platformMessages.js";

test("AI 网络错误按 Web、Android、Electron 给出对应排查方式", () => {
  const web = getAiNetworkErrorMessage();
  const android = getAiNetworkErrorMessage({ native: true });
  const electron = getAiNetworkErrorMessage({ electron: true });

  assert.match(web, /npm run dev/);
  assert.match(android, /设备网络|服务商地址/);
  assert.doesNotMatch(android, /npm run dev|startup\.bat/);
  assert.match(electron, /内嵌本地服务/);
  assert.match(electron, /重新打开应用/);
  assert.doesNotMatch(electron, /npm run dev|startup\.bat/);
});

test("Electron 文件同步警告指向内嵌服务，而非外部开发服务器", () => {
  const electron = getFileSyncIssueText({ electron: true });
  assert.match(electron, /内嵌服务/);
  assert.match(electron, /重新打开应用/);
  assert.doesNotMatch(electron, /npm run dev|startup\.bat/);
});
