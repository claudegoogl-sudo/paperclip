// PLA-818 regression fixture: emulates the messenger inbound relay. While
// servicing a host→worker dispatch (the `onWebhook`/`getUpdates` route), the
// worker calls back into the host with `issues.createComment` WITHOUT echoing
// the host-issued `paperclipInvocationId` — the real wire shape of the relay.
//
// The host's base context cannot bind this id-less callback to the in-flight
// dispatch by id, so it surfaces `invalidInvocationScope: true` (with
// `singleInFlightScope`) and attaches the worker-lifetime `serviceScope`. Before
// the PLA-818 guard-ordering fix the SDK gate threw on `invalidInvocationScope`
// before reaching the PLA-814 serviceScope allowlist bypass, so this createComment
// was denied and the operator reply never landed. After the fix the allowlisted,
// reach-checked createComment is authorized.

const readline = require("node:readline");

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
      result: { data: { commentedVia: message.result } },
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
    const nestedId = `nested-${nextRequestId++}`;
    const params = message.params?.params ?? {};
    pendingNested.set(nestedId, message.id);
    // Inbound relay shape: createComment with a concrete target company but NO
    // `paperclipInvocationId` echo — exactly what the deployed messenger sends.
    send({
      jsonrpc: "2.0",
      id: nestedId,
      method: "issues.createComment",
      params: {
        issueId: params.issueId ?? "issue-1",
        body: params.body ?? "operator reply",
        companyId: params.companyId ?? "company-a",
      },
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
