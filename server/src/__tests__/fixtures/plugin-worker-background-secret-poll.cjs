// Regression fixture: a plugin worker that starts a background poll
// loop at `setup()` time (the shape of the messenger `getUpdates` long-poll)
// and resolves a secret ref from inside that loop.
//
// The loop owns NO dispatch, so — exactly like the real SDK, whose
// AsyncLocalStorage invocation store is empty outside a dispatch — its
// worker->host `secrets.resolve` carries NO `paperclipInvocationId` and NO
// `runId`. Its only legitimate tenant binding is the host-minted
// `serviceScope.runId` that `contextForWorkerMessage` attaches unconditionally.
//
// Separately the host dispatches `onEvent` for some OTHER tenant, which this
// fixture deliberately holds open. While that dispatch is the single in-flight
// one, the host's `singleInFlightScope` attribution outranks `serviceScope` in
// `backfillDispatchRunId`, so the loop's id-less resolve is back-filled with
// that tenant's per-dispatch background runId.

const readline = require("node:readline");

let nextRequestId = 1;
let pollTimer = null;
const heldDispatchIds = [];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// The background loop. No `paperclipInvocationId` and no `runId` — it services
// no dispatch, so the host must bind it to the worker's own service context.
function sendBackgroundSecretResolve() {
  send({
    jsonrpc: "2.0",
    id: `bg-${nextRequestId++}`,
    method: "secrets.resolve",
    params: { secretRef: "telegramBotToken" },
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
      // PLUGIN_FIXTURE_ECHOES_INVOCATION_ID=1 models a modern SDK (after
      // invocation-id echoing was added). Unset models the installed base
      // (messenger 0.1.42, platform.cad <=0.1.7), which predates the field
      // and therefore still relies on the host's single-in-flight attribution.
      result: {
        ok: true,
        supportedMethods: ["onEvent"],
        ...(process.env.PLUGIN_FIXTURE_ECHOES_INVOCATION_ID === "1"
          ? { echoesInvocationId: true }
          : {}),
      },
    });
    pollTimer = setInterval(sendBackgroundSecretResolve, 15);
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
    // Response to one of our background secrets.resolve calls — discard.
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Unhandled method: ${method}` },
  });
});
