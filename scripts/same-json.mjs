// Exit code 0 when two JSON files hold the same value, whatever their key order or spacing.
// Run: node scripts/same-json.mjs a.json b.json
import { readFileSync } from "node:fs";

const sorted = (value) =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]))
      : value;
const [a, b] = process.argv.slice(2).map((path) => JSON.stringify(sorted(JSON.parse(readFileSync(path, "utf8")))));
process.exit(a === b ? 0 : 1);
