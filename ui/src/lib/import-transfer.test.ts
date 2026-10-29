import { describe, expect, it } from "vitest";
import {
  IMPORT_TRANSFER_PART_SIZE_BYTES,
  buildImportTransferManifest,
} from "./import-transfer";

/**
 * Independent sha256 helper, kept separate from the module under test so
 * comparisons below cross-check the implementation rather than restating it.
 */
async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Fast, deterministic non-trivial fill (a 32-bit LCG), so large buffers don't
 * collide with an all-zero buffer and don't pay crypto.getRandomValues'
 * 64KiB-per-call limit.
 */
function fillPseudoRandom(buffer: ArrayBuffer, seed = 0x1234abcd): void {
  const bytes = new Uint8Array(buffer);
  let state = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = state & 0xff;
  }
}

describe("buildImportTransferManifest", () => {
  it("returns no parts and the empty-buffer hash for an empty file", async () => {
    const buffer = new ArrayBuffer(0);
    const manifest = await buildImportTransferManifest(buffer);

    expect(manifest.totalBytes).toBe(0);
    expect(manifest.partSizeBytes).toBe(IMPORT_TRANSFER_PART_SIZE_BYTES);
    expect(manifest.parts).toEqual([]);
    expect(manifest.zipSha256).toBe(await sha256Hex(buffer));
  });

  it("builds a single part for a small file that fits in one chunk", async () => {
    const text = "hello paperclip import transfer";
    const buffer = new TextEncoder().encode(text).buffer;
    const manifest = await buildImportTransferManifest(buffer);

    expect(manifest.totalBytes).toBe(buffer.byteLength);
    expect(manifest.parts).toHaveLength(1);
    expect(manifest.parts[0].index).toBe(0);
    expect(manifest.parts[0].byteSize).toBe(buffer.byteLength);
    expect(manifest.parts[0].sha256).toBe(await sha256Hex(buffer));
    expect(manifest.zipSha256).toBe(await sha256Hex(buffer));
  });

  it("splits a file spanning multiple chunks into correctly bounded, correctly hashed parts", async () => {
    const extra = 777;
    const totalBytes = IMPORT_TRANSFER_PART_SIZE_BYTES + extra;
    const buffer = new ArrayBuffer(totalBytes);
    fillPseudoRandom(buffer);

    const manifest = await buildImportTransferManifest(buffer);

    expect(manifest.totalBytes).toBe(totalBytes);
    expect(manifest.parts).toHaveLength(2);

    // Byte sizes: a full chunk followed by the remainder, no dropped bytes.
    expect(manifest.parts[0].byteSize).toBe(IMPORT_TRANSFER_PART_SIZE_BYTES);
    expect(manifest.parts[1].byteSize).toBe(extra);
    const sumOfParts = manifest.parts.reduce((sum, part) => sum + part.byteSize, 0);
    expect(sumOfParts).toBe(totalBytes);

    // Each part's hash must match an independently sliced byte range at
    // index * partSizeBytes — this is what would catch a chunk-boundary
    // off-by-one or a hash computed over the wrong byte range.
    for (const part of manifest.parts) {
      const offset = part.index * IMPORT_TRANSFER_PART_SIZE_BYTES;
      const slice = new Uint8Array(buffer, offset, part.byteSize);
      expect(part.sha256).toBe(await sha256Hex(slice));
    }

    expect(manifest.zipSha256).toBe(await sha256Hex(buffer));
  });

  it("does not emit a spurious trailing empty part when the file is an exact multiple of the chunk size", async () => {
    const totalBytes = IMPORT_TRANSFER_PART_SIZE_BYTES * 2;
    const buffer = new ArrayBuffer(totalBytes);
    fillPseudoRandom(buffer, 0xfeedface);

    const manifest = await buildImportTransferManifest(buffer);

    expect(manifest.totalBytes).toBe(totalBytes);
    expect(manifest.parts).toHaveLength(2);
    expect(manifest.parts[0].byteSize).toBe(IMPORT_TRANSFER_PART_SIZE_BYTES);
    expect(manifest.parts[1].byteSize).toBe(IMPORT_TRANSFER_PART_SIZE_BYTES);

    for (const part of manifest.parts) {
      const offset = part.index * IMPORT_TRANSFER_PART_SIZE_BYTES;
      const slice = new Uint8Array(buffer, offset, part.byteSize);
      expect(part.sha256).toBe(await sha256Hex(slice));
    }

    expect(manifest.zipSha256).toBe(await sha256Hex(buffer));
  });
});
