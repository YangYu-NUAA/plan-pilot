import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SecureCredentialStore } from "../electron/secureCredentialStore.js";

function fakeSafeStorage() {
  const marker = Buffer.from("fake-ciphertext-v1\0");
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value) => Buffer.concat([marker, Buffer.from(value, "utf8")]),
    decryptStringAsync: async (value) => {
      assert.ok(value.subarray(0, marker.length).equals(marker), "ciphertext marker");
      return { result: value.subarray(marker.length).toString("utf8"), shouldReEncrypt: false };
    },
  };
}

async function tempStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "plan-pilot-credentials-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "nested", "secure-credentials.json");
  return {
    filePath,
    store: new SecureCredentialStore({ filePath, safeStorage: fakeSafeStorage() }),
  };
}

test("安全存储：只落密文，重建实例后仍可读取，删除不残留", async (t) => {
  const { filePath, store } = await tempStore(t);
  const aiKey = "sk-chat-secret-not-plaintext";
  const voiceKey = "sk-voice-secret-not-plaintext";

  // Concurrent writes exercise the per-store serialization queue.
  await Promise.all([store.set("ai", aiKey), store.set("voice", voiceKey)]);
  const raw = await fs.readFile(filePath, "utf8");
  assert.equal(raw.includes(aiKey), false);
  assert.equal(raw.includes(voiceKey), false);
  assert.equal(JSON.parse(raw).ai.length > 20, true);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);

  const restarted = new SecureCredentialStore({ filePath, safeStorage: fakeSafeStorage() });
  assert.equal(await restarted.get("ai"), aiKey);
  assert.equal(await restarted.get("voice"), voiceKey);

  await restarted.set("ai", "");
  assert.equal(await restarted.get("ai"), "");
  assert.equal(await restarted.get("voice"), voiceKey);
  assert.equal((await fs.readFile(filePath, "utf8")).includes(aiKey), false);
});

test("安全存储：空值与未知字段有明确边界", async (t) => {
  const { store } = await tempStore(t);
  assert.equal(await store.get("ai"), "");
  await assert.rejects(async () => store.get("unknown"), /Unsupported credential key/);
  await assert.rejects(async () => store.set("unknown", "secret"), /Unsupported credential key/);
  await assert.rejects(async () => store.set("ai", 42), /Invalid credential value/);
});

test("安全存储：系统加密不可用时拒绝明文降级", async (t) => {
  const { filePath } = await tempStore(t);
  const store = new SecureCredentialStore({
    filePath,
    safeStorage: { isAsyncEncryptionAvailable: async () => false },
  });
  await assert.rejects(() => store.get("ai"), /secure storage is unavailable/);
  await assert.rejects(() => store.set("ai", "must-not-be-written"), /secure storage is unavailable/);
  await assert.rejects(() => fs.stat(filePath), /ENOENT/);
});

test("安全存储：损坏文件不会被静默当成空 Key", async (t) => {
  const { filePath, store } = await tempStore(t);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "{broken", "utf8");
  await assert.rejects(() => store.get("ai"), SyntaxError);
});
