// 网络错误的处理方式取决于运行时：Android 直连上游，Electron 使用内嵌服务，Web 依赖外部开发服务器。
export function getAiNetworkErrorMessage({ native = false, electron = false } = {}) {
  if (native) {
    return "网络不可达：无法连接 AI 服务，请检查设备网络或服务商地址后重试。";
  }
  if (electron) {
    return "Plan Pilot 内嵌本地服务未响应，请完全退出并重新打开应用；若仍失败，请查看故障排查文档。";
  }
  return "本地 API 代理不可达：dev server 未运行或正在重启，请先启动服务（npm run dev 或 startup.bat）再试。";
}

export function getFileSyncIssueText({ electron = false } = {}) {
  if (electron) {
    return "本地文件同步失败：Plan Pilot 内嵌服务未响应。数据仍保留在应用本地存储，AI 与文件同步暂不可用；请完全退出并重新打开应用。";
  }
  return "本地文件同步失败：检测不到本地服务（请运行 npm run dev 或 startup.bat）。数据暂存于浏览器，AI 功能与文件同步不可用。";
}
