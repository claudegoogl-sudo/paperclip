// PLA-673 regression fixture: a worker that emulates the pre-PLA-657 SDK
// shape — it issues `secrets.resolve` without a `runId` field. The host's
// `host-client-factory` gated wrapper is expected to back-fill `runId` from
// the active invocation scope set by the executeTool / performAction bracket.
//
// The fixture also echoes the host-issued `paperclipInvocationId` on the
// nested call so the host can resolve the invocation context (this is what
// any real SDK does, including the pre-PLA-657 one — PLA-657 added the runId
// payload field, not the invocation id echo).

const readline = require("node:readline");

let nextRequestId = 1;
const pendingNested = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendLegacySecretsResolve(originalRequest, invocationId) {
  const nestedId = `nested-${nextRequestId++}`;
  // Legacy wire shape: `{ secretRef }` only — no runId. The host should back-
  // fill runId from the active invocation scope.
  const params = originalRequest.params?.params ?? {};
  const requestedSecretRef = params.secretRef ?? "11111111-1111-1111-1111-111111111111";
  const nestedRequest = {
    jsonrpc: "2.0",
    id: nestedId,
    method: "secrets.resolve",
    params: {
      secretRef: requestedSecretRef,
    },
    paperclipInvocationId: invocationId,
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
    // Echo the resolved value back as the executeTool / performAction result
    // so the test can assert end-to-end success.
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
      result: { ok: true, supportedMethods: ["executeTool", "performAction"] },
    });
    return;
  }

  if (method === "executeTool" || method === "performAction") {
    sendLegacySecretsResolve(message, message.paperclipInvocation?.id);
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
