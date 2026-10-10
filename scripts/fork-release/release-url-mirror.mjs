#!/usr/bin/env node
/**
 * Release-URL mirror for the pre-publish preflight.
 *
 * A draft GitHub release is not anonymously downloadable, but the preflight
 * must resolve dependency URLs BEFORE publishing. This mirror serves the
 * staged (draft) assets at the exact URL strings the release will publish:
 *
 *     https://github.com/claudegoogl-sudo/paperclip/releases/download/<tag>/<asset>
 *
 * The workflow points `github.com` at 127.0.0.1 for the preflight steps and
 * trusts a locally generated certificate, so `npm install` resolves the real
 * URL strings from the byte-identical staged assets. Nothing about the URL a
 * package declares changes between the preflight and the published release.
 *
 * Any path outside the release prefix answers 404 immediately, so a missing
 * or mis-pinned asset fails the install fast instead of hanging.
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = { port: 443, plainHttp: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--assets-dir") args.assetsDir = next();
    else if (arg === "--tag") args.tag = next();
    else if (arg === "--port") args.port = Number(next());
    else if (arg === "--cert") args.cert = next();
    else if (arg === "--key") args.key = next();
    else if (arg === "--plain-http") args.plainHttp = true;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!args.assetsDir || !args.tag) {
    process.stderr.write("Usage: release-url-mirror --assets-dir <dir> --tag <tag> [--port 443] [--cert <pem> --key <pem> | --plain-http]\n");
    process.exit(2);
  }
  if (!args.plainHttp && (!args.cert || !args.key)) {
    process.stderr.write("TLS mode requires --cert and --key (or pass --plain-http for local curl checks)\n");
    process.exit(2);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const urlPrefix = `/claudegoogl-sudo/paperclip/releases/download/${args.tag}/`;
const assetsDir = path.resolve(args.assetsDir);

function serve(req, res) {
  const send = (status, body, contentType = "text/plain") => {
    res.writeHead(status, { "content-type": contentType });
    res.end(body);
  };
  if (req.method !== "GET" && req.method !== "HEAD") return send(405, "method not allowed");
  const url = new URL(req.url, `http://127.0.0.1:${args.port}`);
  if (!url.pathname.startsWith(urlPrefix)) {
    console.error(`[mirror] 404 ${req.url}`);
    return send(404, "not a release asset path");
  }
  const asset = decodeURIComponent(url.pathname.slice(urlPrefix.length));
  if (asset.includes("/") || asset.includes("\\")) return send(404, "invalid asset name");
  const filePath = path.join(assetsDir, asset);
  if (!filePath.startsWith(assetsDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    console.error(`[mirror] 404 ${req.url} (asset missing from staged release)`);
    return send(404, "asset missing from staged release");
  }
  console.error(`[mirror] 200 ${req.url} (${statSync(filePath).size} bytes)`);
  res.writeHead(200, {
    "content-type": "application/x-tar",
    "content-length": statSync(filePath).size,
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(filePath).pipe(res);
}

const server = args.plainHttp
  ? createServer(serve)
  : createHttpsServer(
      {
        key: await readFile(args.key),
        cert: await readFile(args.cert),
      },
      serve,
    );

server.listen(args.port, "127.0.0.1", () => {
  console.error(`[mirror] serving ${urlPrefix}<asset> from ${assetsDir} on 127.0.0.1:${args.port} (${args.plainHttp ? "http" : "https"})`);
});
