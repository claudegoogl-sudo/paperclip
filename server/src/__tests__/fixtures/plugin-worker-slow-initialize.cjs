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
    // Deliberately delay the initialize response well beyond any timeout the
    // test configures, to exercise the host's initialize-timeout path.
    const delayMs = Number(message.params?.config?.initializeDelayMs ?? 60_000);
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { ok: true, supportedMethods: [] },
      });
    }, delayMs);
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
