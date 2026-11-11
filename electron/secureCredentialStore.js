import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ALLOWED_KEYS = new Set(["ai", "voice"]);
const MAX_CREDENTIAL_LENGTH = 32_768;

function assertCredentialKey(key) {
  if (!ALLOWED_KEYS.has(key)) throw new Error("Unsupported credential key.");
}

/**
 * Persists Electron safeStorage ciphertext, never plaintext credentials.
 * safeStorage uses Keychain on macOS; the JSON file only contains opaque base64.
 */
export class SecureCredentialStore {
  constructor({ filePath, safeStorage }) {
    this.filePath = filePath;
    this.safeStorage = safeStorage;
    this.writeQueue = Promise.resolve();
  }

  async isAvailable() {
    if (!this.safeStorage?.isAsyncEncryptionAvailable) return false;
    return this.safeStorage.isAsyncEncryptionAvailable();
  }

  async assertAvailable() {
    if (!(await this.isAvailable())) {
      throw new Error("System secure storage is unavailable. Unlock the system keychain and try again.");
    }
  }

  async readAll() {
    let raw;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }

    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Invalid secure credential store.");
    }
    return data;
  }

  async get(key) {
    assertCredentialKey(key);
    await this.assertAvailable();
    // A read requested after a write must observe that completed write.
    await this.writeQueue.catch(() => {});
    const data = await this.readAll();
    const ciphertext = data[key];
    if (!ciphertext) return "";
    if (typeof ciphertext !== "string") throw new Error("Invalid encrypted credential.");
    const { result, shouldReEncrypt } = await this.safeStorage.decryptStringAsync(Buffer.from(ciphertext, "base64"));
    // Electron can request re-encryption after an OS key rotation/security upgrade.
    if (shouldReEncrypt) await this.set(key, result);
    return result;
  }

  set(key, value) {
    assertCredentialKey(key);
    if (typeof value !== "string" || value.length > MAX_CREDENTIAL_LENGTH) {
      return Promise.reject(new Error("Invalid credential value."));
    }

    const operation = () => this.write(key, value);
    // Serialize updates so chat/voice writes cannot overwrite one another.
    this.writeQueue = this.writeQueue.then(operation, operation);
    return this.writeQueue;
  }

  async write(key, value) {
    await this.assertAvailable();
    const data = await this.readAll();
    if (value) {
      const encrypted = await this.safeStorage.encryptStringAsync(value);
      data[key] = encrypted.toString("base64");
    } else {
      delete data[key];
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.rename(tempPath, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  }
}
