// Sets one new version in all three SDKs. Run: node scripts/bump.mjs <major|minor|patch|X.Y.Z>
// Prints the new version. Before 1.0.0, a break bumps the minor number and anything else bumps the patch number.
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const current = JSON.parse(readFileSync(`${root}typescript/package.json`, "utf8")).version;
const arg = process.argv[2];

function next(version, level) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (major === 0) return level === "major" ? `0.${minor + 1}.0` : `0.${minor}.${patch + 1}`;
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

if (!/^(major|minor|patch|\d+\.\d+\.\d+)$/.test(arg ?? "")) {
  console.error("Usage: node scripts/bump.mjs <major|minor|patch|X.Y.Z>");
  process.exit(2);
}
const version = /^\d/.test(arg) ? arg : next(current, arg);

const edits = [
  ["typescript/package.json", /("version": )"[^"]+"/, `$1"${version}"`],
  ["typescript/src/core.ts", /(export const VERSION = )"[^"]+"/, `$1"${version}"`],
  ["python/pyproject.toml", /^(version = )"[^"]+"/m, `$1"${version}"`],
  ["python/src/frontmost/_core.py", /^(VERSION = )"[^"]+"/m, `$1"${version}"`],
  ["rust/Cargo.toml", /^(version = )"[^"]+"/m, `$1"${version}"`],
  ["rust/Cargo.lock", /(name = "frontmost-ai"\nversion = )"[^"]+"/, `$1"${version}"`],
];
for (const [path, pattern, replacement] of edits) {
  const text = readFileSync(`${root}${path}`, "utf8");
  if (!pattern.test(text)) throw new Error(`No version found in ${path}`);
  writeFileSync(`${root}${path}`, text.replace(pattern, replacement));
}
console.log(version);
