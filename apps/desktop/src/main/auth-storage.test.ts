import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "./auth-storage";

// A deterministic reversible cipher tests storage semantics; Electron supplies
// the real operating-system encryption in the end-to-end suite.
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) =>
    Buffer.from(Buffer.from(value).map((byte) => byte ^ 0xa5)),
  decryptString: (value: Buffer) =>
    Buffer.from(value.map((byte) => byte ^ 0xa5)).toString(),
};

test("transient file locks preserve atomic writes and serialize concurrent token updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mp-auth-storage-"));
  try {
    let attempts = 0;
    const storage = new AuthStorage(
      directory,
      encryption,
      async (source, destination) => {
        if (++attempts <= 2)
          throw Object.assign(new Error("locked"), { code: "EPERM" });
        await rename(source, destination);
      },
    );
    const token = storage.setItem("token", "secret-token");
    const verifier = storage.setItem("verifier", "secret-verifier");
    await Promise.all([token, verifier]);
    assert.equal(attempts, 4);
    assert.equal(await storage.getItem("token"), "secret-token");
    const restored = new AuthStorage(directory, encryption);
    assert.equal(await restored.getItem("verifier"), "secret-verifier");
    assert.equal(
      (await readFile(join(directory, "supabase-session.bin"))).includes(
        Buffer.from("secret-token"),
      ),
      false,
    );
    await Promise.all([
      storage.setItem("token", "refreshed"),
      storage.removeItem("token"),
    ]);
    assert.equal(await storage.getItem("token"), null);
    assert.equal(
      await new AuthStorage(directory, encryption).getItem("token"),
      null,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("permanent locks fail without publishing new values, and the queue can recover", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mp-auth-storage-"));
  try {
    let locked = false;
    let attempts = 0;
    const storage = new AuthStorage(
      directory,
      encryption,
      async (source, destination) => {
        if (locked) {
          attempts++;
          throw Object.assign(new Error("locked"), { code: "EPERM" });
        }
        await rename(source, destination);
      },
    );
    await storage.setItem("token", "original");
    locked = true;
    await assert.rejects(storage.setItem("token", "replacement"), {
      code: "EPERM",
    });
    assert.equal(attempts, 6);
    assert.equal(await storage.getItem("token"), "original");
    assert.equal(
      await new AuthStorage(directory, encryption).getItem("token"),
      "original",
    );
    locked = false;
    await storage.removeItem("token");
    assert.equal(await storage.getItem("token"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unavailable encryption and non-lock failures do not silently store credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mp-auth-storage-"));
  try {
    const unavailable = new AuthStorage(directory, {
      ...encryption,
      isEncryptionAvailable: () => false,
    });
    await assert.rejects(
      unavailable.setItem("token", "value"),
      /encryption is required/,
    );
    let attempts = 0;
    const storage = new AuthStorage(directory, encryption, async () => {
      attempts++;
      throw Object.assign(new Error("disk failure"), { code: "EIO" });
    });
    await assert.rejects(storage.setItem("token", "value"), { code: "EIO" });
    assert.equal(attempts, 1);
    assert.equal(await storage.getItem("token"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
