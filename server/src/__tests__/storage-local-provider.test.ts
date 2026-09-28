import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("local disk storage provider", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("round-trips bytes through storage service", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const content = Buffer.from("hello image bytes", "utf8");
    const stored = await service.putFile({
      companyId: "company-1",
      namespace: "issues/issue-1",
      originalFilename: "demo.png",
      contentType: "image/png",
      body: content,
    });

    const fetched = await service.getObject("company-1", stored.objectKey);
    const fetchedBody = await readStreamToBuffer(fetched.stream);

    expect(fetchedBody.toString("utf8")).toBe("hello image bytes");
    expect(stored.sha256).toHaveLength(64);
  });

  it("streams only requested byte ranges", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const stored = await service.putFile({
      companyId: "company-1",
      namespace: "issues/issue-1",
      originalFilename: "demo.mp4",
      contentType: "video/mp4",
      body: Buffer.from("0123456789", "utf8"),
    });

    const fetched = await service.getObject("company-1", stored.objectKey, { range: { start: 2, end: 5 } });
    const fetchedBody = await readStreamToBuffer(fetched.stream);

    expect(fetchedBody.toString("utf8")).toBe("2345");
    expect(fetched.contentLength).toBe(4);
  });

  it("blocks cross-company object access", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const stored = await service.putFile({
      companyId: "company-a",
      namespace: "issues/issue-1",
      originalFilename: "demo.png",
      contentType: "image/png",
      body: Buffer.from("hello", "utf8"),
    });

    await expect(service.getObject("company-b", stored.objectKey)).rejects.toMatchObject({ status: 403 });
  });

  it("delete is idempotent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const stored = await service.putFile({
      companyId: "company-1",
      namespace: "issues/issue-1",
      originalFilename: "demo.png",
      contentType: "image/png",
      body: Buffer.from("hello", "utf8"),
    });

    await service.deleteObject("company-1", stored.objectKey);
    await service.deleteObject("company-1", stored.objectKey);
    await expect(service.getObject("company-1", stored.objectKey)).rejects.toMatchObject({ status: 404 });
  });
});

describe("local disk provider object-key normalization", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeProvider() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);
    return { root, provider: createLocalDiskStorageProvider(root) };
  }

  it("rejects traversal-shaped object keys on write", async () => {
    const { provider } = await makeProvider();
    const body = Buffer.from("evil", "utf8");
    for (const objectKey of [
      "company-1/a/../b",
      "company-1/../escape",
      "company-1/./x",
      "company-1/a\\..\\b",
      "/company-1/x",
    ]) {
      await expect(provider.putObject({ objectKey, body, contentType: "text/plain", contentLength: body.length }))
        .rejects.toMatchObject({ status: 400 });
    }
  });

  it("rejects traversal-shaped object keys on read", async () => {
    const { provider } = await makeProvider();
    const body = Buffer.from("hello", "utf8");
    await provider.putObject({ objectKey: "company-1/ok.txt", body, contentType: "text/plain", contentLength: body.length });
    for (const objectKey of [
      "company-1/../company-1/ok.txt",
      "company-1/ok.txt/..",
      "company-1/./ok.txt",
      "..",
      ".",
    ]) {
      await expect(provider.getObject({ objectKey })).rejects.toMatchObject({ status: 400 });
      await expect(provider.headObject({ objectKey })).rejects.toMatchObject({ status: 400 });
    }
    // A segment merely containing a dot-run is confinement-safe at the
    // provider level (no traversal escape) but unreadable through the
    // service guard — covered in storage-object-key.test.ts. Here the object
    // does not exist, so the provider reports notFound rather than 400.
    await expect(provider.getObject({ objectKey: "company-1/ok..txt" })).rejects.toMatchObject({ status: 404 });
  });
});
