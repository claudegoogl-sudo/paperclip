const readline = require("node:readline");

// Stream-attribution fixture: a worker that opens/emits/closes
// stream channels either inside a dispatch (echoing the host's
// paperclipInvocation) or outside any dispatch (id-less), mirroring the two
// SDK generations the host must serve. Records host→worker `streams.dropped`
// signals so tests can assert drops are plugin-visible, never silent.

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const droppedNotifications = [];

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const method = message && typeof message.method === "string" ? message.method : null;

  // Host→worker notification (no id): record drop signals, ignore the rest.
  if (method && message.id === undefined) {
    if (method === "streams.dropped") {
      droppedNotifications.push(message.params ?? {});
    }
    return;
  }

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        ok: true,
        supportedMethods: ["performAction"],
      },
    });
    return;
  }

  if (method === "performAction") {
    const outer = (message.params && typeof message.params === "object") ? message.params : {};
    const params = (outer.params && typeof outer.params === "object") ? outer.params : {};
    const scenario = typeof params.scenario === "string" ? params.scenario : "";
    // Echo the host-minted invocation id only while servicing a dispatch that
    // carries one — exactly what the bundled SDK does via its async-local
    // invocation context.
    const invocationId = message.paperclipInvocation ? message.paperclipInvocation.id : undefined;
    const echo = invocationId ? { paperclipInvocationId: invocationId } : {};

    if (scenario === "report-drops") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { dropped: droppedNotifications.splice(0, droppedNotifications.length) },
      });
      return;
    }

    if (scenario === "pin-proactive-trap") {
      // Id-less stream notifications naming a proactively configured company,
      // sent while THIS host→worker request is still pending. The request
      // derives no invocation scope, so the host's proactive-scope path is
      // the only resolver that could attribute these notifications — and
      // stream notifications must never resolve through it (no pin, no
      // delivery, every notification dropped loudly).
      send({ jsonrpc: "2.0", method: "streams.open", params: { channel: params.channel, companyId: params.companyId } });
      send({ jsonrpc: "2.0", method: "streams.emit", params: { channel: params.channel, companyId: params.companyId, event: { n: 1 } } });
      send({ jsonrpc: "2.0", method: "streams.close", params: { channel: params.channel, companyId: params.companyId } });
      send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
      return;
    }

    if (scenario === "open-in-dispatch" || scenario === "open-idless") {
      // open-idless deliberately omits the echo even when a dispatch is in
      // flight (legacy worker shape): the host must not pin from an
      // unattributable open.
      const withEcho = scenario === "open-in-dispatch" ? echo : {};
      send({
        jsonrpc: "2.0",
        method: "streams.open",
        params: { channel: params.channel, companyId: params.companyId },
        ...withEcho,
      });
    } else if (scenario === "open-emit-idless") {
      // Both notifications id-less while the dispatch is still in flight (the
      // "ride concurrent traffic" shape). The host must never pin from either,
      // even when the claimed company is proactively allowlisted.
      send({
        jsonrpc: "2.0",
        method: "streams.open",
        params: { channel: params.channel, companyId: params.companyId },
      });
      send({
        jsonrpc: "2.0",
        method: "streams.emit",
        params: { channel: params.channel, companyId: params.companyId, event: { n: 0 } },
      });
    } else if (scenario === "emit") {
      send({
        jsonrpc: "2.0",
        method: "streams.emit",
        params: {
          channel: params.channel,
          companyId: params.companyId,
          event: params.event !== undefined ? params.event : { n: 1 },
        },
        ...echo,
      });
    } else if (scenario === "close") {
      send({
        jsonrpc: "2.0",
        method: "streams.close",
        params: { channel: params.channel, companyId: params.companyId },
        ...echo,
      });
    }

    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { ok: true },
    });
    return;
  }

  if (method === "shutdown") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {},
    });
    setImmediate(() => process.exit(0));
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32601,
      message: `Unhandled method: ${method}`,
    },
  });
});
