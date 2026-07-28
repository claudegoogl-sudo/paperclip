// PLA-1838 counter-fixture: a pre-PLA-657 (id-less) plugin worker that resolves
// a secret from INSIDE its own dispatch.
//
// This is the population PLA-719 exists for: the worker echoes no
// `paperclipInvocationId` even while servicing its own `onEvent`, so
// `singleInFlightScope` is the only binding the host can attribute the call to.
// The PLA-1838 fix must keep this working — the discriminator has to be "does
// this call own a dispatch", not "which scope key is present".

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
    // Resolve a secret while servicing this dispatch, with no id and no runId.
    send({
      jsonrpc: "2.0",
      id: `dispatch-${nextRequestId++}`,
      method: "secrets.resolve",
      params: { secretRef: "telegramBotToken" },
    });
    // Settle the dispatch only after the resolve has had time to round-trip,
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
    // Response to our secrets.resolve — discard.
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Unhandled method: ${method}` },
  });
});
