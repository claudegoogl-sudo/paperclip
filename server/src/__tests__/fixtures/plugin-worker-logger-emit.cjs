const readline = require("node:readline");

/**
 * Fixture worker: emits worker→host `log` notifications (what `ctx.logger.*`
 * produces) so the host's log-notification persist path can be tested against
 * a real child process.
 *
 * Modes (via `getData` params):
 *  - "dispatch-log": emits one `log` notification that ECHOES the dispatch's
 *    `paperclipInvocationId`, so the host pins the row to the dispatch company.
 *  - "proactive-log": emits one id-less `log` notification with no dispatch in
 *    flight — a setup()-loop style log that has no claim to any company.
 */

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendLog(invocationId, level, message, meta) {
  const notification = {
    jsonrpc: "2.0",
    method: "log",
    params: { level, message, meta },
  };
  if (invocationId) notification.paperclipInvocationId = invocationId;
  send(notification);
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
      result: {
        ok: true,
        supportedMethods: ["getData"],
        echoesInvocationId: true,
      },
    });
    return;
  }

  if (method === "getData") {
    const params = message.params || {};
    const invocationId = message.paperclipInvocation
      ? message.paperclipInvocation.id
      : undefined;
    if (params.mode === "dispatch-log") {
      sendLog(
        invocationId,
        params.level || "error",
        params.message || "evt.dispatch_failed",
        params.meta || {
          plugin: "test.plugin",
          method: "upload_gcode",
          error: "config.get denied: missing invocation scope",
        },
      );
    } else if (params.mode === "proactive-log") {
      sendLog(
        null,
        params.level || "warn",
        params.message || "evt.proactive_warn",
        params.meta || { plugin: "test.plugin" },
      );
    }
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
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
