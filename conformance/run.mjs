// Starts the mock, then runs each SDK's conformance test against it. Exit code 1 if any language fails.
// node conformance/run.mjs [typescript|python|rust ...]
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

const root = new URL("..", import.meta.url).pathname;
const LANGS = {
  typescript: { cwd: "typescript", build: ["npx", "tsc", "-p", "."], test: ["node", "--test", "test/"] },
  python: { cwd: "python", build: null, test: ["uv", "run", "--quiet", "pytest", "-q", "tests/test_conformance.py"] },
  rust: { cwd: "rust", build: null, test: ["cargo", "test", "--quiet"] },
};
const chosen = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(LANGS);

const mock = spawn("node", [`${root}conformance/mock.mjs`], { stdio: ["ignore", "pipe", "inherit"] });
const [line] = await once(mock.stdout, "data");
const baseURL = String(line).trim();
const env = { ...process.env, FRONTMOST_BASE_URL: baseURL, FRONTMOST_API_KEY: "fmk_test" };

const results = {};
for (const name of chosen) {
  const l = LANGS[name];
  const run = (cmd) => spawnSync(cmd[0], cmd.slice(1), { cwd: `${root}${l.cwd}`, env, stdio: "inherit" }).status === 0;
  results[name] = (!l.build || run(l.build)) && run(l.test);
}
mock.kill();
for (const [name, ok] of Object.entries(results)) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
process.exit(Object.values(results).every(Boolean) ? 0 : 1);
