// 极轻的勾选音效：Web Audio 合成，无音频文件，保持 local-first。
// 默认关闭，由设置抽屉开关（settings.soundFx）。
let ctx = null;

export function playTick(settings) {
  if (!settings?.soundFx) return;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    const t = ctx.currentTime;
    // 两个短促正弦音：880Hz → 1320Hz，营造「叮」的上扬感
    const notes = [
      { freq: 880, at: 0, dur: 0.07, gain: 0.12 },
      { freq: 1318.5, at: 0.06, dur: 0.09, gain: 0.1 },
    ];
    for (const { freq, at, dur, gain } of notes) {
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      amp.gain.setValueAtTime(0, t + at);
      amp.gain.linearRampToValueAtTime(gain, t + at + 0.012);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      osc.connect(amp).connect(ctx.destination);
      osc.start(t + at);
      osc.stop(t + at + dur + 0.02);
    }
  } catch {
    // 音频不可用时静默失败，不影响打卡
  }
}
