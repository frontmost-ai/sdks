// The pre-merge SDK check. node codegen/sync.mjs <new openapi.json> [--write]
// 1. Breaking diff against spec/openapi.json (the released spec).
// 2. Regenerate all three SDKs from the new spec in a temporary copy, or in place with --write.
// 3. Compile and run the conformance cases for each language.
// Exit code 1 when a break, a compile error, or a failed case exists.

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [spec, flag] = process.argv.slice(2);
if (!spec) {
  console.error("Usage: node codegen/sync.mjs <new openapi.json> [--write]");
  process.exit(2);
}
const repo = new URL("..", import.meta.url).pathname;
const write = flag === "--write";
const dir = write ? repo : mkdtempSync(join(tmpdir(), "frontmost-sdks-"));
if (!write) cpSync(repo, dir, { recursive: true, filter: (p) => !/\/(target|\.venv|\.git)(\/|$)/.test(p) });

const step = (label, cmd, args) => {
  console.log(`\n== ${label}`);
  return spawnSync(cmd, args, { cwd: dir, stdio: "inherit" }).status === 0;
};

const breaking = step("Breaking diff", "node", ["codegen/breaking.mjs", join(repo, "spec/openapi.json"), spec]);
cpSync(spec, join(dir, "spec/openapi.json"));
const generated = ["typescript", "python", "rust"].every((l) => step(`Generate ${l}`, "node", [`codegen/${l}.mjs`]));
const tested = generated && step("Compile and run conformance", "node", ["conformance/run.mjs"]);
if (!write) rmSync(dir, { recursive: true, force: true });

console.log(`\nbreaking diff: ${breaking ? "pass" : "FAIL"}  generate: ${generated ? "pass" : "FAIL"}  conformance: ${tested ? "pass" : "FAIL"}`);
process.exit(breaking && generated && tested ? 0 : 1);
