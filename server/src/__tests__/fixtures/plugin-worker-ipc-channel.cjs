// PLA-1154 regression fixture: a worker that reports whether it has a live node
// IPC channel (fd 3). The host now spawns workers with a 3-fd stdio and NO ipc
// entry, so the worker must see no `process.send`, no `process.channel`, and a
// raw write to fd 3 must fail (the fd does not exist) — proving the worker→host
// OOM bypass of PLA-1149's stdout frame cap is gone.
const readline = require("node:readline");
const fs = require("node:fs");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function probeIpc() {
  let fd3Write;
  try {
    // With no ipc channel, fd 3 is not provisioned → EBADF (or similar).
    fs.writeSync(3, Buffer.from("x".repeat(1024)));
    fd3Write = { threw: false };
  } catch (err) {
    fd3Write = { threw: true, code: err && err.code };
  }
  return {
    hasProcessSend: typeof process.send === "function",
    hasChannel: process.channel != null,
    fd3Write,
  };
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
    send({ jsonrpc: "2.0", id: message.id, result: probeIpc() });
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
