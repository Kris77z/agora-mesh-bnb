import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { withLocalFileLock } from "@rebel/shared";
import type { PersistedAltanaSession } from "./session-codec.js";

interface EncryptedRecord {
  iv: string;
  authTag: string;
  ciphertext: string;
}

interface EncryptedStoreFile {
  version: 1;
  records: Record<string, EncryptedRecord>;
}

function parseEncryptionKey(value: string): Buffer {
  const trimmed = value.trim();
  if (/^(?:0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed.replace(/^0x/, ""), "hex");
  }
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length !== 32) {
    throw new Error("ALTANA_SESSION_ENCRYPTION_KEY must be 32-byte hex or base64");
  }
  return decoded;
}

export class EncryptedAltanaSessionStore {
  private readonly key: Buffer;

  constructor(
    private readonly storePath: string,
    encryptionKey: string
  ) {
    this.key = parseEncryptionKey(encryptionKey);
  }

  private async readStore(): Promise<EncryptedStoreFile> {
    try {
      const parsed = JSON.parse(await readFile(this.storePath, "utf8")) as EncryptedStoreFile;
      if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== "object") {
        throw new Error("Altana session store has an unsupported format");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, records: {} };
      }
      throw error;
    }
  }

  private async writeStore(store: EncryptedStoreFile): Promise<void> {
    await mkdir(path.dirname(this.storePath), { recursive: true });
    const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.storePath);
  }

  async save(authorityId: string, record: PersistedAltanaSession): Promise<void> {
    if (record.authority.authorityId !== authorityId) throw new Error("Authority ID does not match session record");
    return withLocalFileLock(this.storePath, async () => {
    const store = await this.readStore();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(authorityId, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(record), "utf8"),
      cipher.final()
    ]);
    store.records[authorityId] = {
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
    await this.writeStore(store);
    });
  }

  async load(authorityId: string): Promise<PersistedAltanaSession | undefined> {
    const encrypted = (await this.readStore()).records[authorityId];
    if (!encrypted) {
      return undefined;
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(encrypted.iv, "base64")
    );
    decipher.setAAD(Buffer.from(authorityId, "utf8"));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
    return JSON.parse(plaintext) as PersistedAltanaSession;
  }

  async delete(authorityId: string): Promise<void> {
    return withLocalFileLock(this.storePath, async () => {
    const store = await this.readStore();
    if (!(authorityId in store.records)) {
      return;
    }
    delete store.records[authorityId];
    await this.writeStore(store);
    });
  }
}
