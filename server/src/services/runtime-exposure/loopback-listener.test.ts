import net from "node:net";
import { describe, expect, it } from "vitest";

import { RUNTIME_EXPOSURE_APP_PORT_MIN, deriveViteHmrPort } from "@paperclipai/shared";

import {
  diagnoseRuntimeListenerBinds,
  formatProcAddressHex,
  listenerBindFactsForPort,
  parseProcNetListeners,
} from "./loopback-listener.js";

// Real header and row shape, copied from a live /proc/net/tcp{,6} on the host
// that produced the PAP-17256 failures. Port 42003 is A40B; 52003 is CB23.
const TCP_HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode                                                     ";
const TCP6_HEADER =
  "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

function tcpRow(addrHex: string, portHex: string, state = "0A") {
  return `   0: ${addrHex}:${portHex} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000   999        0 74815359 1 0000000000000000 100 0 0 10 0`;
}

function tcp6Row(addrHex: string, portHex: string, state = "0A") {
  return `   0: ${addrHex}:${portHex} 00000000000000000000000000000000:0000 ${state} 00000000:00000000 00:00000000 00000000   999        0 74815360 2 0000000000000000 100 0 0 10 0`;
}

/** The app port from the PAP-17256 lane, and its `/proc` hex form. */
const APP_PORT = 42_003;
const portHex = (port: number) => port.toString(16).toUpperCase().padStart(4, "0");
const APP_PORT_HEX = portHex(APP_PORT);

describe("formatProcAddressHex", () => {
  it("byte-swaps IPv4 words", () => {
    expect(formatProcAddressHex("0100007F")).toBe("127.0.0.1");
    expect(formatProcAddressHex("00000000")).toBe("0.0.0.0");
    expect(formatProcAddressHex("0400007F")).toBe("127.0.0.4");
  });

  it("renders the IPv6 loopback and wildcard forms /proc actually stores", () => {
    expect(formatProcAddressHex("00000000000000000000000001000000")).toBe("::1");
    expect(formatProcAddressHex("00000000000000000000000000000000")).toBe("::");
  });
});

describe("listenerBindFactsForPort", () => {
  it("accepts an IPv4 loopback listener", () => {
    const facts = listenerBindFactsForPort(
      parseProcNetListeners(`${TCP_HEADER}\n${tcpRow("0100007F", APP_PORT_HEX)}\n`),
      [],
      APP_PORT,
    );
    expect(facts).toEqual({ present: true, loopbackOnly: true, addresses: ["127.0.0.1"] });
  });

  it("accepts an IPv6 loopback listener in the little-endian ::1 form", () => {
    const facts = listenerBindFactsForPort(
      [],
      parseProcNetListeners(
        `${TCP6_HEADER}\n${tcp6Row("00000000000000000000000001000000", APP_PORT_HEX)}\n`,
      ),
      APP_PORT,
    );
    expect(facts).toEqual({ present: true, loopbackOnly: true, addresses: ["::1"] });
  });

  it("rejects the 0.0.0.0 wildcard bind that broke every managed lane", () => {
    const facts = listenerBindFactsForPort(
      parseProcNetListeners(`${TCP_HEADER}\n${tcpRow("00000000", APP_PORT_HEX)}\n`),
      [],
      APP_PORT,
    );
    expect(facts).toEqual({ present: true, loopbackOnly: false, addresses: ["0.0.0.0"] });
  });

  it("rejects the :: wildcard bind", () => {
    const facts = listenerBindFactsForPort(
      [],
      parseProcNetListeners(
        `${TCP6_HEADER}\n${tcp6Row("00000000000000000000000000000000", APP_PORT_HEX)}\n`,
      ),
      APP_PORT,
    );
    expect(facts.loopbackOnly).toBe(false);
    expect(facts.addresses).toEqual(["::"]);
  });

  it("rejects a non-loopback unicast bind", () => {
    // 100.123.243.20 — the tailnet address, stored little-endian.
    const facts = listenerBindFactsForPort(
      parseProcNetListeners(`${TCP_HEADER}\n${tcpRow("14F37B64", APP_PORT_HEX)}\n`),
      [],
      APP_PORT,
    );
    expect(facts.loopbackOnly).toBe(false);
    expect(facts.addresses).toEqual(["100.123.243.20"]);
  });

  it("reports absent for a port with no LISTEN row", () => {
    const facts = listenerBindFactsForPort(
      // Same port, but ESTABLISHED (01) rather than LISTEN (0A).
      parseProcNetListeners(`${TCP_HEADER}\n${tcpRow("0100007F", APP_PORT_HEX, "01")}\n`),
      [],
      APP_PORT,
    );
    expect(facts).toEqual({ present: false, loopbackOnly: true, addresses: [] });
  });

  it("ignores rows for other ports", () => {
    const facts = listenerBindFactsForPort(
      parseProcNetListeners(`${TCP_HEADER}\n${tcpRow("00000000", portHex(52_003))}\n`),
      [],
      APP_PORT,
    );
    expect(facts.present).toBe(false);
  });

  it("is not loopback-only when a wildcard row accompanies a loopback row", () => {
    const facts = listenerBindFactsForPort(
      parseProcNetListeners(
        `${TCP_HEADER}\n${tcpRow("0100007F", APP_PORT_HEX)}\n${tcpRow("00000000", APP_PORT_HEX)}\n`,
      ),
      [],
      APP_PORT,
    );
    expect(facts.loopbackOnly).toBe(false);
    expect(facts.addresses).toEqual(["127.0.0.1", "0.0.0.0"]);
  });
});

describe("diagnoseRuntimeListenerBinds against live listeners", () => {
  // The whole dedicated app range (42000-42999) sits inside Linux's default
  // ephemeral source-port range, so ANY fixed port here can transiently
  // collide with an unrelated loopback connection's source port and fail
  // `listen` with EADDRINUSE on a loaded runner (seen in Release run
  // 35798195266: both 127.0.0.1:42900 and [::]:42900 were squatted by the
  // same transient occupant). Scan a small window of the allowlist instead
  // of pinning one port: a squatted candidate is skipped and the test
  // converges on a bindable one.
  const APP_PORT_CANDIDATES = Array.from(
    { length: 10 },
    (_, index) => RUNTIME_EXPOSURE_APP_PORT_MIN + 900 + index,
  );

  function isEaddrInuse(err: unknown): boolean {
    return (
      typeof err === "object" &&
      err !== null &&
      (err as NodeJS.ErrnoException).code === "EADDRINUSE"
    );
  }

  async function withListener<T>(
    port: number,
    host: string | undefined,
    body: () => Promise<T>,
  ): Promise<T> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      if (host === undefined) server.listen(port, () => resolve());
      else server.listen(port, host, () => resolve());
    });
    try {
      return await body();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** Retry `bind` across the candidate window when a port is EADDRINUSE-squatted. */
  async function withBindableListener<T>(
    host: string | undefined,
    body: (boundPort: number) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown = null;
    for (const candidate of APP_PORT_CANDIDATES) {
      try {
        return await withListener(candidate, host, () => body(candidate));
      } catch (err) {
        if (!isEaddrInuse(err)) throw err;
        lastError = err;
      }
    }
    throw lastError ?? new Error("no app port candidate could be bound");
  }

  /**
   * Bind the app/HMR pair for one candidate (app loopback-only, HMR
   * hostless, mirroring the tests' original shapes). Either port being
   * squatted moves the whole pair to the next candidate so the derived
   * pairing always holds.
   */
  async function withAppAndHmrListeners<T>(
    body: (appPort: number, hmrPort: number) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown = null;
    for (const candidate of APP_PORT_CANDIDATES) {
      const hmrCandidate = deriveViteHmrPort(candidate);
      try {
        return await withListener(candidate, "127.0.0.1", () =>
          withListener(hmrCandidate, undefined, () => body(candidate, hmrCandidate)));
      } catch (err) {
        if (!isEaddrInuse(err)) throw err;
        lastError = err;
      }
    }
    throw lastError ?? new Error("no app/HMR port candidate pair could be bound");
  }

  it("stays silent for a real loopback listener", async () => {
    await withBindableListener("127.0.0.1", async (appPort) => {
      expect(await diagnoseRuntimeListenerBinds([appPort])).toBeNull();
    });
  });

  it("names the port and the wildcard address for a real 0.0.0.0 listener", async () => {
    await withBindableListener(undefined, async (appPort) => {
      const diagnosis = await diagnoseRuntimeListenerBinds([appPort]);
      expect(diagnosis).toContain(`port ${appPort}`);
      // Node's hostless listen is dual-stack, so /proc shows :: and/or 0.0.0.0.
      expect(diagnosis).toMatch(/0\.0\.0\.0|::/);
      expect(diagnosis).toContain("--bind loopback");
    });
  });

  it("catches the HMR companion port too, not just the app port", async () => {
    await withAppAndHmrListeners(async (appPort, hmrPort) => {
      const diagnosis = await diagnoseRuntimeListenerBinds([appPort, hmrPort]);
      expect(diagnosis).toContain(`port ${hmrPort}`);
      expect(diagnosis).not.toContain(`port ${appPort} is bound`);
    });
  });

  it("stays silent for a port with no listener, leaving the verdict to the broker", async () => {
    // Bind-release a candidate first: a successful bind proves the port is
    // bindable right now, so once released it is verifiably listener-free for
    // the diagnose call below (the /proc LISTEN row disappears on close with
    // no connections pending). This keeps the original coverage — a port with
    // no listener at all must also stay silent — without pinning a constant
    // an ephemeral-port squatter could occupy.
    const appPort = await withBindableListener("127.0.0.1", async (port) => port);
    expect(await diagnoseRuntimeListenerBinds([appPort])).toBeNull();
  });
});
