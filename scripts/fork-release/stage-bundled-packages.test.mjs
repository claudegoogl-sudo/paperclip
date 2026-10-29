import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "stage-bundled-packages.mjs",
);

test("npm pack runs with --ignore-scripts so a package's prepack cannot re-run its build in the stage dir", () => {
  const source = readFileSync(scriptPath, "utf8");
  const packCall = source.slice(source.indexOf('spawnSync("npm", ["pack"'));
  assert.match(
    packCall,
    /spawnSync\("npm", \["pack", "--ignore-scripts"/,
    // @paperclipai/server's prepack runs `bash ../scripts/prepare-server-ui-dist.sh`
    // and `pnpm run build`; the stage dir carries only the package's `files`
    // entries and the bundled deps' node_modules, not the repo's root
    // scripts/ dir or devDependencies, so an un-ignored prepack fails
    // `npm pack` outright (reproduced on CI: "npm pack failed for
    // @paperclipai/server (exit 1)").
  );
});
