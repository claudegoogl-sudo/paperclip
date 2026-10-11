// Fixture: a plugin worker that, while servicing an `onEvent` dispatch, makes
// one worker->host `probe.provenance` request. PROVENANCE_ECHO_MODE selects
// what it echoes as `paperclipInvocationId`:
//   "valid" - the host-minted id from `message.paperclipInvocation`
//   "none"  - nothing (id-less; the single-in-flight shape)
//   "bogus" - an id the host never minted
const readline = require("node:readline");

const mode = process.env.PROVENANCE_ECHO_MODE || "valid";
let nextRequestId = 1;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

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
        supportedMethods: ["onEvent"],
        ...(mode === "valid" ? { echoesInvocationId: true } : {}),
      },
    });
    return;
  }

  if (method === "onEvent") {
    const minted = message.paperclipInvocation ? message.paperclipInvocation.id : undefined;
    const echoed =
      mode === "valid" ? minted : mode === "bogus" ? "00000000-0000-4000-8000-000000000000" : undefined;
    send({
      jsonrpc: "2.0",
      id: `probe-${nextRequestId++}`,
      method: "probe.provenance",
      params: {},
      ...(echoed ? { paperclipInvocationId: echoed } : {}),
    });
    setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: null }), 150);
    return;
  }

  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    setImmediate(() => process.exit(0));
    return;
  }

  if (message.id !== undefined && method === null) return;

  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unhandled method: ${method}` } });
});
