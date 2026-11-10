import { useEffect, useRef, useState } from "react";

function readBrowserKey(storageKey) {
  try {
    return localStorage.getItem(storageKey) || "";
  } catch {
    return "";
  }
}

function removeBrowserKey(storageKey) {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // The encrypted copy is already authoritative; an orphaned legacy value is non-fatal.
  }
}

function nativeCredentials() {
  return typeof window !== "undefined" ? window.planPilotNative?.credentials || null : null;
}

/**
 * Web/Android: origin-local storage (existing behaviour).
 * Electron: async IPC to safeStorage, independent of the random local-server port.
 */
export function usePersistentKey({ storageKey, nativeKey }) {
  const native = nativeCredentials();
  const [value, setValue] = useState(() => (native ? "" : readBrowserKey(storageKey)));
  const [status, setStatus] = useState({
    ready: !native,
    saving: false,
    backend: native ? "system" : "browser",
    error: "",
  });
  const operationRef = useRef(0);

  useEffect(() => {
    if (!native) return undefined;
    let active = true;
    const operation = ++operationRef.current;

    async function load() {
      try {
        const availability = await native.status();
        if (!active || operationRef.current !== operation) return;
        if (!availability.available) throw new Error("System secure storage unavailable.");

        const saved = await native.get(nativeKey);
        if (!active || operationRef.current !== operation) return;
        const legacy = readBrowserKey(storageKey);
        if (!saved && legacy) {
          await native.set(nativeKey, legacy);
          if (!active || operationRef.current !== operation) return;
        }
        removeBrowserKey(storageKey);
        setValue(saved || legacy);
        setStatus({ ready: true, saving: false, backend: availability.backend || "system", error: "" });
      } catch (error) {
        console.error(`${nativeKey} secure-storage read failed:`, error);
        if (!active || operationRef.current !== operation) return;
        // Keep a just-upgraded installation usable, but never write a new plaintext fallback.
        setValue(readBrowserKey(storageKey));
        setStatus({
          ready: true,
          saving: false,
          backend: "unavailable",
          error: "无法读取系统钥匙串中的 Key。请确认钥匙串已解锁；重新输入可重试保存。",
        });
      }
    }

    load();
    return () => { active = false; };
  }, [native, nativeKey, storageKey]);

  async function updateValue(nextValue) {
    const next = String(nextValue ?? "");
    setValue(next);

    if (!native) {
      try {
        if (next) localStorage.setItem(storageKey, next);
        else localStorage.removeItem(storageKey);
        setStatus({ ready: true, saving: false, backend: "browser", error: "" });
      } catch (error) {
        console.error(`${storageKey} localStorage write failed:`, error);
        setStatus({ ready: true, saving: false, backend: "browser", error: "浏览器存储写入失败，本次输入可能无法在重启后保留。" });
      }
      return;
    }

    const operation = ++operationRef.current;
    setStatus((current) => ({ ...current, ready: true, saving: true, error: "" }));
    try {
      await native.set(nativeKey, next);
      removeBrowserKey(storageKey);
      if (operationRef.current !== operation) return;
      setStatus((current) => ({ ...current, ready: true, saving: false, backend: current.backend === "unavailable" ? "system" : current.backend, error: "" }));
    } catch (error) {
      console.error(`${nativeKey} secure-storage write failed:`, error);
      if (operationRef.current !== operation) return;
      setStatus((current) => ({
        ...current,
        ready: true,
        saving: false,
        error: "Key 保存到系统安全存储失败；本次输入仅在当前窗口有效。请检查钥匙串权限后重试。",
      }));
    }
  }

  return [value, updateValue, status];
}
