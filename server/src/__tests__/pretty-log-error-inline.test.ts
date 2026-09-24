import { describe, expect, it, vi, beforeEach } from "vitest";
import { prettyFactory } from "pino-pretty";
import { prettySharedOptions } from "../middleware/pretty-log-options.js";

/**
 * Regression: pino-pretty's default `errorLikeObjectKeys` includes `error`, so
 * a log event carrying its failure reason in a meta `error` key rendered that
 * reason as an indented error BLOCK on a CONTINUATION line — even in
 * singleLine mode. Any single-line grep/jq for the event name matched the
 * event line but showed no reason, which mis-led a log triage into reporting
 * that plugin failure context was lost entirely. The host logger therefore
 * narrows `errorLikeObjectKeys` to the standard `err` key: meta `error`
 * renders inline on the event line, while `err` Error objects keep their
 * multi-line block.
 */

const mockTransport = vi.hoisted(() => vi.fn(() => ({ write: vi.fn() })));
const mockPino = vi.hoisted(() => {
  const fn = vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(),
  }));
  (fn as any).transport = mockTransport;
  return fn;
});

// Mock fs so the module-level mkdirSync call is a no-op in tests.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn() };
});

vi.mock("pino", () => ({
  default: mockPino,
}));
vi.mock("pino-http", () => ({
  pinoHttp: vi.fn(() => vi.fn()),
}));
vi.mock("../config-file.js", () => ({
  readConfigFile: vi.fn(() => null),
}));
vi.mock("../home-paths.js", () => ({
  resolveHomeAwarePath: vi.fn((p: string) => p),
  resolveDefaultLogsDir: vi.fn(() => "/tmp/paperclip-test-logs"),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("pino-pretty renders meta `error` inline on the event line", () => {
  it("configures every pino-pretty target with errorLikeObjectKeys: [err]", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await import("../middleware/logger.js");

    expect(mockTransport).toHaveBeenCalledOnce();
    const transport = mockTransport.mock.calls[0][0] as {
      targets?: Array<{ target: string; options: Record<string, unknown> }>;
    };
    const prettyTargets = (transport.targets ?? []).filter((t) => t.target === "pino-pretty");
    // Both surfaces (stdout and the server.log file) must agree, or triage
    // behavior differs between the console and the file operators grep.
    expect(prettyTargets.length).toBe(2);
    for (const t of prettyTargets) {
      expect(t.options.errorLikeObjectKeys).toEqual(["err"]);
      expect(t.options.singleLine).toBe(true);
    }
  });

  it("renders an event with a meta `error` reason as ONE greppable line (AC2 shape)", () => {
    // The incident-shaped event: a plugin error log with the failure reason
    // in the meta `error` key, exactly the shape worker logs carry.
    const line = JSON.stringify({
      level: 50,
      time: 1758706954000,
      service: "plugin-worker",
      pluginLogLevel: "error",
      plugin: "klipper",
      method: "upload_gcode",
      error:
        "Plugin is not allowed to perform config.get: the worker referenced a missing, expired, or unknown invocation scope",
      msg: "[plugin] klipper.config_read_failed",
    });

    const rendered = prettyFactory({ ...prettySharedOptions, colorize: false })(line);

    // The event name and the reason must sit ON the matched line: a
    // single-line grep for the event name sees the reason without -A1.
    const trimmed = rendered.trim();
    expect(trimmed.split("\n").length).toBe(1);
    expect(trimmed).toContain("[plugin] klipper.config_read_failed");
    expect(trimmed).toContain(
      "the worker referenced a missing, expired, or unknown invocation scope",
    );
    // Live line shape: "[HH:MM:SS] ERROR: [plugin] <event> {...fields inline}"
    expect(trimmed).toMatch(/^\[\d{2}:\d{2}:\d{2}\] ERROR: /);
    expect(trimmed).toContain('"method":"upload_gcode"');
  });

  it("keeps standard `err` Error objects as a multi-line block", () => {
    const line = JSON.stringify({
      level: 50,
      time: 1758706954000,
      err: {
        type: "Error",
        message: "connect ECONNREFUSED 127.0.0.1:5432",
        stack: "Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect",
      },
      msg: "database unavailable",
    });

    const rendered = prettyFactory({ ...prettySharedOptions, colorize: false })(line);
    const trimmed = rendered.trim();

    // The `err` key stays error-like: header line plus the indented stack
    // block on continuation lines.
    expect(trimmed.split("\n").length).toBeGreaterThan(1);
    expect(trimmed).toContain("database unavailable");
    expect(trimmed).toContain("connect ECONNREFUSED 127.0.0.1:5432");
    expect(trimmed).toContain("at TCPConnectWrap.afterConnect");
  });
});
