// Compares two OpenAPI files and lists changes that break SDK users. Exit code 1 when one exists.
// node codegen/breaking.mjs <old openapi.json> <new openapi.json>
//
// A break is a change that makes working code fail after an SDK upgrade or after a deploy:
//   - an operation is gone, or its method or path changed
//   - a query param or body field is gone, is newly required, or changed type
//   - a request enum lost a value
//   - a response field is gone, changed type, or can now be null
// Anything else is an addition: a new operation, a new optional param, a new response field,
// or a new value in a response enum (each SDK reads a value it does not know without an error).

import { load } from "./ir.mjs";

const [oldFile, newFile] = process.argv.slice(2);
if (!oldFile || !newFile) {
  console.error("Usage: node codegen/breaking.mjs <old openapi.json> <new openapi.json>");
  process.exit(2);
}
const a = load(oldFile);
const b = load(newFile);
const breaks = [];
const adds = [];

const deref = (s, schemas) => (s?.$ref ? schemas[s.$ref.split("/").at(-1)] : s) ?? {};
const types = (s) => {
  if (!s) return new Set();
  if (s.anyOf || s.oneOf) return new Set((s.anyOf ?? s.oneOf).flatMap((x) => [...types(x)]));
  if (s.const !== undefined) return new Set([typeof s.const]);
  return new Set([s.type].flat().filter(Boolean));
};
const enumOf = (s) => s?.enum ?? (s?.anyOf ?? s?.oneOf)?.flatMap((x) => x.enum ?? (x.const !== undefined ? [x.const] : [])) ?? null;

/** Walks two schemas side by side. `side` is "request" (what the SDK sends) or "response" (what it reads). */
function compare(where, x, y, side, seen = new Set()) {
  x = deref(x, a.schemas);
  y = deref(y, b.schemas);
  const key = `${where}`;
  if (seen.has(key)) return;
  seen.add(key);

  const tx = types(x), ty = types(y);
  const nonNull = (t) => [...t].filter((v) => v !== "null").sort().join("|");
  if (tx.size && ty.size && nonNull(tx) !== nonNull(ty)) breaks.push(`${where}: type ${nonNull(tx)} became ${nonNull(ty)}`);
  if (side === "response" && !tx.has("null") && ty.has("null")) breaks.push(`${where}: can now be null`);

  const ex = enumOf(x), ey = enumOf(y);
  if (ex && ey) {
    const lost = ex.filter((v) => !ey.includes(v));
    const gained = ey.filter((v) => !ex.includes(v));
    if (side === "request" && lost.length) breaks.push(`${where}: no longer accepts ${lost.join(", ")}`);
    // Lists of values can grow (site/api.md), and every SDK reads an unknown value, so a new response value is an addition.
    if (side === "response" && gained.length) adds.push(`${where}: can now return ${gained.join(", ")}`);
    if (side === "request" && gained.length) adds.push(`${where}: now accepts ${gained.join(", ")}`);
  }

  const px = x.properties ?? {}, py = y.properties ?? {};
  const rx = new Set(x.required ?? []), ry = new Set(y.required ?? []);
  for (const k of Object.keys(px)) {
    if (!(k in py)) breaks.push(`${where}.${k}: removed`);
    else compare(`${where}.${k}`, px[k], py[k], side, seen);
  }
  for (const k of Object.keys(py)) {
    if (k in px) {
      if (side === "request" && ry.has(k) && !rx.has(k)) breaks.push(`${where}.${k}: now required`);
      if (side === "response" && rx.has(k) && !ry.has(k)) breaks.push(`${where}.${k}: can now be missing`);
    } else if (side === "request" && ry.has(k)) breaks.push(`${where}.${k}: new and required`);
    else adds.push(`${where}.${k}: new`);
  }
  if (x.items || y.items) compare(`${where}[]`, x.items, y.items, side, seen);
}

const id = (o) => `${o.resource}.${o.verb}`;
const byId = (ir) => new Map(ir.operations.map((o) => [id(o), o]));
const oldOps = byId(a), newOps = byId(b);

for (const [name, o] of oldOps) {
  const n = newOps.get(name);
  if (!n) { breaks.push(`${name}: operation removed`); continue; }
  if (o.httpMethod !== n.httpMethod || o.path !== n.path) breaks.push(`${name}: ${o.httpMethod} ${o.path} became ${n.httpMethod} ${n.path}`);
  const qx = new Map(o.query.map((p) => [p.name, p])), qy = new Map(n.query.map((p) => [p.name, p]));
  for (const [k, p] of qx) {
    const q = qy.get(k);
    if (!q) breaks.push(`${name}(${k}): query param removed`);
    else {
      if (q.required && !p.required) breaks.push(`${name}(${k}): now required`);
      compare(`${name}(${k})`, p.schema, q.schema, "request");
    }
  }
  for (const [k, q] of qy) if (!qx.has(k)) (q.required ? breaks : adds).push(`${name}(${k}): new${q.required ? " and required" : ""} query param`);
  if (o.body || n.body) compare(`${name} body`, o.body, n.body, "request");
  if (o.response && n.response) compare(`${name} -> ${n.response}`, { $ref: `#/${o.response}` }, { $ref: `#/${n.response}` }, "response");
  else if (o.response && !n.response) breaks.push(`${name}: response lost its type ${o.response}`);
  else if (!o.response && n.response) adds.push(`${name}: response now typed as ${n.response}`);
}
for (const name of newOps.keys()) if (!oldOps.has(name)) adds.push(`${name}: new operation`);

const uniq = (xs) => [...new Set(xs)];
for (const x of uniq(breaks)) console.log(`BREAK  ${x}`);
for (const x of uniq(adds)) console.log(`ADD    ${x}`);
const bump = breaks.length ? "major" : adds.length ? "minor" : "none";
console.log(`\n${uniq(breaks).length} breaking, ${uniq(adds).length} added. SDK version bump: ${bump}.`);
process.exit(breaks.length ? 1 : 0);
