const readline = require("node:readline");

// PLA-773 fixture: a worker whose `onEvent` background dispatch calls back into
// the host via `secrets.resolve`, echoing the host-supplied invocation id but
// omitting runId — so the host must back-fill runId from the (background)
// invocation scope it minted for the triggering company.

let nextRequestId = 1;
const pendingNested = new Map();

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

  if (message.id && pendingNested.has(message.id)) {
    const originalId = pendingNested.get(message.id);
    pendingNested.delete(message.id);
    if (message.error) {
      send({ jsonrpc: "2.0", id: originalId, error: message.error });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: originalId,
      result: { resolvedTo: message.result },
    });
    return;
  }

  const method = message && typeof message.method === "string" ? message.method : null;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { ok: true, supportedMethods: ["onEvent"] },
    });
    return;
  }

  if (method === "onEvent") {
    const nestedId = `nested-${nextRequestId++}`;
    pendingNested.set(nestedId, message.id);
    send({
      jsonrpc: "2.0",
      id: nestedId,
      method: "secrets.resolve",
      // Echo the host-minted invocation id; omit runId so the host back-fills.
      paperclipInvocationId: message.paperclipInvocation?.id,
      params: { secretRef: message.params?.event?.secretRef },
    });
    return;
  }

  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    setImmediate(() => process.exit(0));
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Unhandled method: ${method}` },
  });
});
