import { useCallback, useEffect, useRef, useState } from "react";
import { appNow } from "../utils/clock.js";import { getLocalDate, toMinutes } from "../utils/dateTime.js";
import { playTick } from "../utils/soundFx.js";

// 块前提醒：今天每个任务块（非 busy）开始前 5 分钟与开始时刻各提醒一次。
// 页内浮层提醒（8s 自动消失）；Electron 壳内另发系统通知（Chromium 的
// Notification 在 Electron 免授权直发；浏览器里不申请权限、仅浮层，避免打扰）。
const LEAD_MINUTES = 5;

export function useBlockReminders({ blocks, settings }) {
  const [reminder, setReminder] = useState(null); // { id, text }
  const firedRef = useRef(new Set()); // key: `${date}|${start}|${kind}` 防重
  const hideTimerRef = useRef(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const dismiss = useCallback(() => {
    clearTimeout(hideTimerRef.current);
    setReminder(null);
  }, []);

  useEffect(() => {
    function check() {
      const today = getLocalDate();
      const now = appNow();
      const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

      const todays = blocks.filter((b) => b.date === today && b.type !== "busy");
      for (const block of todays) {
        const start = toMinutes(block.start);
        const lead = start - nowMin;
        const title = block.title || "";

        const fire = (kind, text) => {
          const key = `${block.date}|${block.start}|${kind}`;
          if (firedRef.current.has(key)) return;
          firedRef.current.add(key);
          setReminder({ id: key, text });
          playTick(settingsRef.current);
          if (typeof Notification !== "undefined" && !("documentPictureInPicture" in window)) {
            // Electron：系统通知；浏览器里静默（浮层足够）
            try { new Notification("Plan Pilot", { body: text }); } catch { /* ignore */ }
          }
          clearTimeout(hideTimerRef.current);
          hideTimerRef.current = setTimeout(() => setReminder(null), 8000);
        };

        if (lead > 0 && lead <= LEAD_MINUTES) {
          fire("lead", `${Math.max(1, Math.round(lead))} 分钟后开始：${title || "时间块"}`);
        } else if (lead <= 0 && lead > -0.5) {
          fire("start", `现在开始：${title || "时间块"}`);
        }
      }
    }

    check();
    const timer = setInterval(check, 20_000);
    return () => {
      clearInterval(timer);
      clearTimeout(hideTimerRef.current);
    };
  }, [blocks]);

  return [reminder, dismiss];
}
