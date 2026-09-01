import { describe, expect, it } from "vitest";

import { getWorkerBootstrapSource } from "./sandboxed-parser-worker";

describe("sandboxed parser worker bootstrap", () => {
  it("disables child worker and object URL escape hatches", () => {
    const source = getWorkerBootstrapSource();

    // Dangerous globals are shadowed via shadowGlobal(name), not a direct
    // assignment — some engines expose readonly accessor globals (e.g.
    // `caches`) where a plain `self.x = _undefined` throws and would abort
    // the whole bootstrap script. See the caches-getter regression test below.
    expect(source).toContain('shadowGlobal("Worker")');
    expect(source).toContain('shadowGlobal("SharedWorker")');
    expect(source).toContain('shadowGlobal("Blob")');
    expect(source).toContain('shadowGlobal("RTCPeerConnection")');
    expect(source).toContain('shadowGlobal("RTCDataChannel")');
    expect(source).toContain('"createObjectURL"');
    expect(source).toContain('"revokeObjectURL"');
  });

  it("shadows every dangerous global through the getter-safe helper, including caches", () => {
    const source = getWorkerBootstrapSource();

    // Regression test: WorkerGlobalScope.caches is a readonly
    // accessor property in current browser engines. A direct assignment
    // (`self.caches = _undefined`) throws "Cannot set property caches ...
    // which has only a getter" in strict mode, which fires worker.onerror
    // during bootstrap before "ready" is ever posted — so every
    // external-adapter UI parser silently failed to load and every run
    // log/preview pane fell back to raw, unstyled stdout lines.
    expect(source).toContain('function shadowGlobal(name) {');
    expect(source).toContain('try { self[name] = _undefined; } catch {}');
    expect(source).toContain('shadowGlobal("caches")');
    expect(source).not.toMatch(/\bself\.caches\s*=\s*_undefined;/);
  });

  it("evaluates parser source in strict mode", () => {
    expect(getWorkerBootstrapSource()).toContain('\\"use strict\\";\\n{\\n" + msg.source');
  });

  it("does not include the unused parse_batch protocol branch", () => {
    expect(getWorkerBootstrapSource()).not.toContain("parse_batch");
  });
});
