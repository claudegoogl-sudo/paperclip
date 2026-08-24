const readline = require("node:readline");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const method = message && typeof message.method === "string" ? message.method : null;

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
    // Company-scoped stream notification emitted with no paperclipInvocationId
    // while the host has no active invocation scope. The host must drop it
    // (fail-closed) rather than forward it under no tenant pin.
    send({
      jsonrpc: "2.0",
      method: "streams.emit",
      params: { channel: "scoped-dropped", companyId: "company-x", payload: { n: 1 } },
    });
    // Scope-less stream notification (no companyId) is always forwarded. It is
    // sent after the dropped one so the host processes both before responding,
    // making the assertion deterministic.
    send({
      jsonrpc: "2.0",
      method: "streams.emit",
      params: { channel: "no-company", payload: { n: 2 } },
    });
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
