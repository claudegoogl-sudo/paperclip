// Fixture: a worker that answers `onEvent` as a JSON-RPC request and, per
// event type, makes an id-less worker->host call inside or after the handler.
// Used by plugin-worker-onevent-request.test.ts.
//
// event.type:
//   probe-after    reply, then id-less companies.list ~30ms later (no dispatch)
//   probe-inside   id-less companies.list, reply ~150ms later (in flight)
//   config-after   reply, then id-less config.get ~30ms later
//   config-inside  id-less config.get, reply ~150ms later
//   hang           never reply
//   throw          reply with an error, then id-less companies.list ~30ms later
// `runJob` replies after 400ms (a second in-flight dispatch).
const readline = require("node:readline");

const echoes = process.env.PLUGIN_FIXTURE_ECHOES_INVOCATION_ID === "1";
let nextRequestId = 1;
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const idless = (method, params) =>
  send({ jsonrpc: "2.0", id: `w-${nextRequestId++}`, method, params });

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const method = typeof message.method === "string" ? message.method : null;
  if (method === null) return; // response to one of our calls
  // A notification (no id) is handled the same way, like the real SDK, but
  // gets no reply.
  const reply = (result) => {
    if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result });
  };

  if (method === "initialize") {
    reply({ ok: true, supportedMethods: ["onEvent", "runJob"], ...(echoes ? { echoesInvocationId: true } : {}) });
    return;
  }
  if (method === "onEvent") {
    const type = message.params && message.params.event && message.params.event.type;
    switch (type) {
      case "probe-after":
        reply(null);
        setTimeout(() => idless("companies.list", {}), 30);
        return;
      case "probe-inside":
        idless("companies.list", {});
        setTimeout(() => reply(null), 150);
        return;
      case "config-after":
        reply(null);
        setTimeout(() => idless("config.get", {}), 30);
        return;
      case "config-inside":
        idless("config.get", {});
        setTimeout(() => reply(null), 150);
        return;
      case "hang":
        return;
      case "throw":
        if (message.id !== undefined) {
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "handler failed" } });
        }
        setTimeout(() => idless("companies.list", {}), 30);
        return;
      default:
        reply(null);
        return;
    }
  }
  if (method === "runJob") {
    setTimeout(() => reply(null), 400);
    return;
  }
  if (method === "shutdown") {
    reply({});
    setImmediate(() => process.exit(0));
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unhandled method: ${method}` } });
  }
});
