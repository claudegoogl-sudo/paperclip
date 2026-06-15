// PLA-1149 regression fixture: a worker that, on demand, emits a single
// worker→host IPC frame far larger than any configured cap, with NO trailing
// newline, to exercise the host-side bounded frame reader (the host must drop +
// terminate before buffering the whole payload).
const readline = require("node:readline");

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
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { ok: true, supportedMethods: ["environmentExecute"] },
    });
    return;
  }

  if (method === "environmentExecute") {
    const bytes = Number(message.params?.oversizeBytes ?? 0);
    // One oversized, newline-less write — never followed by a response.
    process.stdout.write("x".repeat(bytes));
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
