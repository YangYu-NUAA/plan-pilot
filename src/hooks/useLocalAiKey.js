import { AI_KEY_STORAGE_KEY } from "../constants/appConstants.js";
import { usePersistentKey } from "./usePersistentKey.js";

export function useLocalAiKey() {
  return usePersistentKey({ storageKey: AI_KEY_STORAGE_KEY, nativeKey: "ai" });
}
