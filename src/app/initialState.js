export const defaultState = {
  settings: {
    workSegments: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }],
    shortBreak: 10,
    longBreak: 30,
    // 每日工作时长上限（分钟），添加工作时段时校验
    maxWorkMinutes: 600,
    // 显式休息时段（午休等）；空数组 = 按工作时段之间的间隙自动推断
    breaks: [],
    // 打卡音效（Web Audio 合成，默认关闭）
    soundFx: false,
    // 语音识别方式：stepfun=阶跃 ASR（经服务器代理，隐私优先）；browser=浏览器识别（无需 Key）
    voiceEngine: "stepfun",
  },
  ai: {
    enabled: true,
    provider: "deepseek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    profileLearningEnabled: false,
  },
  goals: [],
  tasks: [],
  blocks: [],
  dayPlans: {},
  reviews: [],
  recurring: [],
};
