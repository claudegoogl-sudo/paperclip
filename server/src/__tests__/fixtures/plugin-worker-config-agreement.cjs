// Fixture: models a `setup()`-time `config.get` read — a call made
// with ZERO active invocations, so the host attaches only the worker-lifetime
// `serviceScope` (no `invocationScope`/`singleInFlightScope` pin exists yet).
// This is the shape that must resolve via the host-minted agreement gate
// (`getAgreedOrDeny`) rather than fail closed outright.
//
// The nested `config.get` request is sent BEFORE responding to `initialize`,
// and the `initialize` response is held back until the nested response
// arrives. This makes the ordering deterministic for the test: by the time
// `handle.start()` resolves, the config.get round trip (host handler,
// including any real DB round trip) has already completed and its outcome is
// captured, with no race against a later `executeTool` query for it.

const readline = require("node:readline");

let nextRequestId = 1;
const pendingNested = new Map();
let pendingInitializeId = null;
let configGetOutcome = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendNoDispatchConfigGet() {
  const nestedId = `nested-${nextRequestId++}`;
  const nestedRequest = {
    jsonrpc: "2.0",
    id: nestedId,
    method: "config.get",
    params: {},
  };
  pendingNested.set(nestedId, true);
  send(nestedRequest);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  if (message.id && pendingNested.has(message.id)) {
    pendingNested.delete(message.id);
    configGetOutcome = message.error
      ? { ok: false, error: message.error }
      : { ok: true, result: message.result };
    send({
      jsonrpc: "2.0",
      id: pendingInitializeId,
      result: { ok: true, supportedMethods: ["executeTool"] },
    });
    return;
  }

  const method = message && typeof message.method === "string" ? message.method : null;

  if (method === "initialize") {
    pendingInitializeId = message.id;
    sendNoDispatchConfigGet();
    return;
  }

  if (method === "executeTool") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { data: { configGetOutcome } },
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
