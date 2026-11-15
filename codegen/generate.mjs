// Writes the three generated files from spec/openapi.json. Run: node codegen/generate.mjs
// Exit code 1 if a generator fails.
import { spawnSync } from "node:child_process";

const dir = new URL(".", import.meta.url).pathname;
const failed = ["typescript", "python", "rust"].filter(
  (lang) => spawnSync("node", [`${dir}${lang}.mjs`], { stdio: "inherit" }).status !== 0,
);
if (failed.length) console.error(`Failed: ${failed.join(", ")}`);
process.exit(failed.length ? 1 : 0);
