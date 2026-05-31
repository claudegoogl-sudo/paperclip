// PLA-719 regression fixture: a worker that faithfully emulates the REAL
// pre-PLA-657 platform.cad worker (cad ≤0.1.7). Unlike
// `plugin-worker-legacy-secrets.cjs`, it does NOT echo the host-issued
// `paperclipInvocationId` on its nested `secrets.resolve` call — the deployed
// cad worker's `callHost` never threads it (verified: `worker.js` has zero
// `paperclipInvocation` references). It also omits `runId`.
//
// With only PLA-673 in place this call fails closed at the server's secrets
// handler (`runcontext_invalid`) because the host cannot resolve an invocation
// scope to back-fill from. PLA-719 lets the host attribute the id-less callback
// to the single in-flight dispatch and surface its scope via
// `singleInFlightScope`, so the runId back-fill succeeds.

const readline = require("node:readline");

let nextRequestId = 1;
const pendingNested = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendNoIdSecretsResolve(originalRequest) {
  const nestedId = `nested-${nextRequestId++}`;
  const params = originalRequest.params?.params ?? {};
  const requestedSecretRef = params.secretRef ?? "11111111-1111-1111-1111-111111111111";
  // Legacy wire shape, faithfully: `{ secretRef }` only — NO runId and,
  // crucially, NO `paperclipInvocationId` echo.
  const nestedRequest = {
    jsonrpc: "2.0",
    id: nestedId,
    method: "secrets.resolve",
    params: {
      secretRef: requestedSecretRef,
    },
  };
  pendingNested.set(nestedId, originalRequest.id);
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
    const originalId = pendingNested.get(message.id);
    pendingNested.delete(message.id);
    if (message.error) {
      send({ jsonrpc: "2.0", id: originalId, error: message.error });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: originalId,
      result: { data: { resolvedTo: message.result } },
    });
    return;
  }

  const method = message && typeof message.method === "string" ? message.method : null;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { ok: true, supportedMethods: ["executeTool"] },
    });
    return;
  }

  if (method === "executeTool") {
    sendNoIdSecretsResolve(message);
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
