// PLA-1824 regression fixture: a plugin worker that starts a background poll
// loop at `setup()` time (the shape of the messenger `getUpdates` long-poll).
//
// The loop owns NO dispatch, so — exactly like the real SDK, whose
// AsyncLocalStorage invocation store is empty outside a dispatch — its
// worker->host `config.get` carries NO `paperclipInvocationId`.
//
// Separately the host dispatches `onEvent` for some OTHER tenant, which this
// fixture deliberately holds open. While that dispatch is the single in-flight
// one, the host's `singleInFlightScope` attribution resolves the loop's id-less
// `config.get` to that tenant.

const readline = require("node:readline");

let nextRequestId = 1;
let pollTimer = null;
const heldDispatchIds = [];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// The background loop. No `paperclipInvocationId` — it services no dispatch.
function sendBackgroundConfigGet() {
  send({
    jsonrpc: "2.0",
    id: `bg-${nextRequestId++}`,
    method: "config.get",
    params: {},
  });
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
      // PLUGIN_FIXTURE_ECHOES_INVOCATION_ID=1 models a modern (post-PLA-657)
      // SDK, which echoes `paperclipInvocationId` whenever it is inside a
      // dispatch — so an id-less call from it owns no dispatch. Unset models a
      // pre-PLA-657 worker (platform.cad ≤0.1.7), which never echoes the id and
      // therefore still needs PLA-719's single-in-flight attribution.
      result: {
        ok: true,
        supportedMethods: ["onEvent"],
        ...(process.env.PLUGIN_FIXTURE_ECHOES_INVOCATION_ID === "1"
          ? { echoesInvocationId: true }
          : {}),
      },
    });
    // setup(): start the background poll. Note this begins BEFORE any dispatch
    // exists, so it can never be "the worker servicing its own dispatch".
    pollTimer = setInterval(sendBackgroundConfigGet, 15);
    if (pollTimer.unref) pollTimer.unref();
    return;
  }

  if (method === "onEvent") {
    // Hold the dispatch open so it stays the single in-flight invocation while
    // the background loop ticks underneath it.
    heldDispatchIds.push(message.id);
    setTimeout(() => {
      const id = heldDispatchIds.shift();
      if (id !== undefined) send({ jsonrpc: "2.0", id, result: null });
    }, 300);
    return;
  }

  if (method === "shutdown") {
    if (pollTimer) clearInterval(pollTimer);
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    setImmediate(() => process.exit(0));
    return;
  }

  if (message.id !== undefined && method === null) {
    // Response to one of our background config.get calls — discard.
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Unhandled method: ${method}` },
  });
});
