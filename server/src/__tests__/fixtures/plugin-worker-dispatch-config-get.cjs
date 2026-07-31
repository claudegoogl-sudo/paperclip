// PLA-719 fixture: a pre-PLA-657 (id-less) plugin worker that reads its
// effective config from INSIDE its own dispatch, with no background loop.
//
// This is the population PLA-719 exists for: the worker echoes no
// `paperclipInvocationId` even while servicing its own `onEvent`, so
// `singleInFlightScope` is the only binding the host can attribute the call to.
// Because it never calls id-less with nothing in flight, PLA-1838's
// host-observed "owns no dispatch" signal never fires for it and the
// attribution is preserved.

const readline = require("node:readline");

let nextRequestId = 1;

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
    // No `echoesInvocationId` — this worker predates the field.
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { ok: true, supportedMethods: ["onEvent"] },
    });
    return;
  }

  if (method === "onEvent") {
    send({
      jsonrpc: "2.0",
      id: `dispatch-${nextRequestId++}`,
      method: "config.get",
      params: {},
    });
    // Settle the dispatch only after the config.get has had time to round-trip,
    // so the invocation is still in flight when the host handles it.
    setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: null }), 150);
    return;
  }

  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    setImmediate(() => process.exit(0));
    return;
  }

  if (message.id !== undefined && method === null) {
    // Response to our config.get — discard.
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Unhandled method: ${method}` },
  });
});
