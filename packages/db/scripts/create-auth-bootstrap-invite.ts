import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, gt, isNull } from "drizzle-orm";
import { createDb } from "../src/client.js";
import {
  buildEmbeddedPostgresConnectionString,
  readEmbeddedPostgresCredential,
  socketDirectoryPathFor,
} from "../src/embedded-postgres-auth.js";
import { invites } from "../src/schema/index.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createInviteToken() {
  return `pcp_bootstrap_${randomBytes(24).toString("hex")}`;
}

function readArg(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

async function main() {
  const configPath = readArg("--config");
  const baseUrl = readArg("--base-url");

  if (!configPath || !baseUrl) {
    throw new Error("Usage: tsx create-auth-bootstrap-invite.ts --config <path> --base-url <url>");
  }

  const config = JSON.parse(readFileSync(path.resolve(configPath), "utf8")) as {
    database?: {
      mode?: string;
      embeddedPostgresPort?: number;
      embeddedPostgresDataDir?: string;
      connectionString?: string;
    };
  };
  let dbUrl: string | undefined;
  if (config.database?.mode === "postgres") {
    dbUrl = config.database.connectionString;
  } else if (config.database?.mode === "embedded-postgres" || !config.database?.mode) {
    const port = config.database?.embeddedPostgresPort ?? 54329;
    const dataDir = config.database?.embeddedPostgresDataDir;
    const cred = dataDir ? readEmbeddedPostgresCredential(dataDir) : null;
    if (cred) {
      dbUrl = buildEmbeddedPostgresConnectionString({
        port,
        database: "paperclip",
        password: cred.password,
        socketDir: dataDir ? socketDirectoryPathFor(dataDir) : undefined,
      });
    }
  }
  if (!dbUrl) {
    throw new Error(
      `Could not resolve database connection from ${configPath} ` +
        `(embedded-postgres mode requires a per-install credential file beside the data dir; ` +
        `start the Paperclip server once so it generates one).`,
    );
  }

  const db = createDb(dbUrl);
  const closableDb = db as typeof db & {
    $client?: {
      end?: (options?: { timeout?: number }) => Promise<void>;
    };
  };

  try {
    const now = new Date();
    await db
      .update(invites)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(invites.inviteType, "bootstrap_ceo"),
          isNull(invites.revokedAt),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, now)
        )
      );

    const token = createInviteToken();
    await db.insert(invites).values({
      inviteType: "bootstrap_ceo",
      tokenHash: hashToken(token),
      allowedJoinTypes: "human",
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      invitedByUserId: "system",
    });

    process.stdout.write(`${baseUrl.replace(/\/+$/, "")}/invite/${token}\n`);
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
