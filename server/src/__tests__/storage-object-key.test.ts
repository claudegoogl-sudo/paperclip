import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  assertObjectKeyReadable,
  isObjectKeyReadable,
  repairObjectKey,
} from "../storage/object-key.js";
import { createStorageService } from "../storage/service.js";
import type { StorageProvider } from "../storage/types.js";

function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

describe("isObjectKeyReadable", () => {
  it("accepts well-formed company-prefixed keys", () => {
    expect(isObjectKeyReadable("company-1/issues/issue-1/2026/09/13/uuid-file.epro")).toBe(true);
    expect(isObjectKeyReadable("company-1/a.b.c.txt")).toBe(true);
  });

  it("rejects traversal and malformed shapes", () => {
    expect(isObjectKeyReadable("")).toBe(false);
    expect(isObjectKeyReadable("a/../b")).toBe(false);
    expect(isObjectKeyReadable("../b")).toBe(false);
    expect(isObjectKeyReadable("a..b")).toBe(false);
    expect(isObjectKeyReadable("a/..")).toBe(false);
    expect(isObjectKeyReadable("a\\..\\b")).toBe(false);
    expect(isObjectKeyReadable("a\\b")).toBe(false);
    expect(isObjectKeyReadable("/a/b")).toBe(false);
    expect(isObjectKeyReadable("a/./b")).toBe(false);
    expect(isObjectKeyReadable("./a")).toBe(false);
    expect(isObjectKeyReadable("a//b")).toBe(false);
    expect(isObjectKeyReadable("a/b/")).toBe(false);
  });
});

describe("repairObjectKey", () => {
  it("returns already-valid keys unchanged", () => {
    const key = "company-1/issues/i/2026/09/13/uuid-file.epro";
    expect(repairObjectKey(key)).toBe(key);
  });

  it("hardens dot-runs inside filename segments", () => {
    expect(
      repairObjectKey("company-1/issues/i/2026/09/13/uuid-name..epro"),
    ).toBe("company-1/issues/i/2026/09/13/uuid-name.epro");
    expect(repairObjectKey("company-1/a..b.txt")).toBe("company-1/a.b.txt");
  });

  it("refuses structural traversal it must not rewrite", () => {
    expect(repairObjectKey("company-1/../escape")).toBeNull();
    expect(repairObjectKey("company-1/./x")).toBeNull();
    expect(repairObjectKey("company-1/a//b")).toBeNull();
    expect(repairObjectKey("company-1/a\\..\\b")).toBeNull();
  });

  it("refuses dot-runs in directory segments (only the filename segment is rewritten)", () => {
    expect(repairObjectKey("company-1/issues..sub/x.txt")).toBeNull();
    expect(repairObjectKey("company-1/issues..sub/uuid-name..epro")).toBeNull();
  });
});

describe("storage service object-key guard parity (provider-agnostic)", () => {
  it("fails closed on write: the built key never carries a dot-dot run", async () => {
    const seen: string[] = [];
    const provider: StorageProvider = {
      id: "s3",
      putObject: async (input) => {
        seen.push(`put:${input.objectKey}`);
      },
      getObject: async (input) => {
        seen.push(`get:${input.objectKey}`);
        return { stream: Readable.from(Buffer.from("x")), contentLength: 1 };
      },
      headObject: async () => ({ exists: true, contentLength: 1 }),
      deleteObject: async () => {},
    };
    const service = createStorageService(provider);

    for (const filename of [
      "ProPrj_driver_v2_mirco_OP_edit..epro",
      "a..b.txt",
      "x.",
      "..epro",
      "..hidden.txt",
    ]) {
      seen.length = 0;
      const stored = await service.putFile({
        companyId: "company-1",
        namespace: "issues/issue-1",
        originalFilename: filename,
        contentType: "application/octet-stream",
        body: Buffer.from("payload", "utf8"),
      });
      expect(seen[0]).toBe(`put:${stored.objectKey}`);
      expect(stored.objectKey).not.toContain("..");
      expect(isObjectKeyReadable(stored.objectKey)).toBe(true);
    }
  });

  it("rejects unreadable keys on read before any provider call (S3 id proves parity)", async () => {
    const seen: string[] = [];
    const provider: StorageProvider = {
      id: "s3",
      putObject: async () => {},
      getObject: async (input) => {
        seen.push(input.objectKey);
        return { stream: Readable.from(Buffer.from("x")), contentLength: 1 };
      },
      headObject: async () => ({ exists: true, contentLength: 1 }),
      deleteObject: async () => {},
    };
    const service = createStorageService(provider);

    const invalidButPrefixed = [
      "company-1/a..b",
      "company-1/a/../b",
      "company-1/./x",
      "company-1/a\\..\\b",
      "company-1//x",
    ];
    for (const key of invalidButPrefixed) {
      await expect(service.getObject("company-1", key)).rejects.toMatchObject({ status: 400 });
      await expect(service.headObject("company-1", key)).rejects.toMatchObject({ status: 400 });
      await expect(service.deleteObject("company-1", key)).rejects.toMatchObject({ status: 400 });
    }
    // absolute paths fail the company-prefix check first (403), still rejected
    await expect(service.getObject("company-1", "/company-1/x")).rejects.toMatchObject({ status: 403 });
    expect(seen).toEqual([]);
  });
});

describe("storage service builder corpus", () => {
  it("round-trips hostile filenames through a real local provider", async () => {
    const { createLocalDiskStorageProvider } = await import("../storage/local-disk-provider.js");
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-object-key-"));
    try {
      const service = createStorageService(createLocalDiskStorageProvider(root));
      const body = Buffer.from("corpus-payload", "utf8");
      for (const filename of [
        "ProPrj_driver_v2_mirco_OP_edit..epro",
        "a..b.txt",
        "x.",
        "..epro",
      ]) {
        const stored = await service.putFile({
          companyId: "company-1",
          namespace: "issues/issue-1",
          originalFilename: filename,
          contentType: "application/octet-stream",
          body,
        });
        const fetched = await service.getObject("company-1", stored.objectKey);
        expect(await readStreamToBuffer(fetched.stream)).toEqual(body);
        const ranged = await service.getObject("company-1", stored.objectKey, {
          range: { start: 0, end: 3 },
        });
        expect(await readStreamToBuffer(ranged.stream)).toEqual(body.subarray(0, 4));
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("defuses traversal-shaped namespaces into safe keys on write", async () => {
    const { createLocalDiskStorageProvider } = await import("../storage/local-disk-provider.js");
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-object-key-"));
    try {
      const service = createStorageService(createLocalDiskStorageProvider(root));
      // A traversal-shaped *namespace* is sanitized, never carried through:
      // the emitted key stays company-prefixed and free of dot-dots.
      const stored = await service.putFile({
        companyId: "company-1",
        namespace: "issues/../../escape",
        originalFilename: "x.txt",
        contentType: "text/plain",
        body: Buffer.from("x", "utf8"),
      });
      expect(stored.objectKey).not.toContain("..");
      expect(isObjectKeyReadable(stored.objectKey)).toBe(true);
      expect(stored.objectKey.startsWith("company-1/")).toBe(true);
      // and the object is readable again through the guarded read path
      const fetched = await service.getObject("company-1", stored.objectKey);
      expect(await readStreamToBuffer(fetched.stream)).toEqual(Buffer.from("x", "utf8"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("assertObjectKeyReadable", () => {
  it("throws 400 with the historical message", () => {
    expect(() => assertObjectKeyReadable("a..b")).toThrowError(
      expect.objectContaining({ status: 400, message: "Invalid object key" }),
    );
  });
});
