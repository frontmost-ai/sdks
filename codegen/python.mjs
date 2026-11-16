// Writes python/src/frontmost/_generated.py from the shared operation list. Run: node codegen/python.mjs
// The output is a pure function of spec/openapi.json, so CI can regenerate it and fail on any diff.
// Types are TypedDicts because responses are plain JSON. A nested object becomes its own TypedDict named after its parent.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load, nullable, pascal } from "./ir.mjs";

// One pinned formatter version, so every machine writes the same file.
const RUFF = "ruff@0.17.5";
const OUT = fileURLToPath(new URL("../python/src/frontmost/_generated.py", import.meta.url));

const ir = load();

const KEYWORDS = new Set("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" "));
const RESERVED = new Set(["self", "body", "options"]);

/** Every name the generator writes as Python must be a plain identifier. A bad name stops the build. */
function ident(name, where) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || KEYWORDS.has(name)) throw new Error(`${where}: "${name}" is not a usable Python name`);
  return name;
}

const lit = (v) => (v === null ? "None" : v === true ? "True" : v === false ? "False" : JSON.stringify(v));
const escape = (text) => text.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
const docstring = (text, indent) => (text ? `${indent}"""${escape(text)}"""\n` : "");
const comment = (text, indent) => (text ? `${indent}# ${text.replace(/\n/g, " ")}\n` : "");

const out = [];
const exported = [];

/** One JSON Schema to one Python type. `name` names any TypedDict this schema needs. */
function py(s, name) {
  if (!s || Object.keys(s).filter((k) => k !== "description").length === 0) return "Any";
  if (s.$ref) return s.$ref.split("/").at(-1);
  if (s.const !== undefined) return `Literal[${lit(s.const)}]`;
  if (s.enum) return `Literal[${s.enum.map(lit).join(", ")}]`;
  const n = nullable(s);
  if (n.nullable) return `Optional[${py(n.schema, name)}]`;
  if (s.anyOf || s.oneOf) return union((s.anyOf ?? s.oneOf).map((x) => py(x, name)));
  if (Array.isArray(s.type)) return union(s.type.map((t) => py({ ...s, type: t }, name)));
  switch (s.type) {
    case "null": return "None";
    case "string": return "str";
    case "integer": return "int";
    case "number": return "float";
    case "boolean": return "bool";
    case "array": return `list[${py(s.items, `${name}Item`)}]`;
    case "object": return Object.keys(s.properties ?? {}).length ? typedDict(name, s) : "dict[str, Any]";
    default: return "Any";
  }
}

const union = (types) => ([...new Set(types)].length === 1 ? types[0] : `Union[${[...new Set(types)].join(", ")}]`);

/** Writes a TypedDict, after any nested TypedDicts it uses, and returns its name. */
function typedDict(name, s) {
  if (exported.includes(name)) throw new Error(`${name}: two types share this name`);
  const req = new Set(s.required ?? []);
  const fields = Object.entries(s.properties).map(([k, v]) => {
    const type = py(v, `${name}${pascal(ident(k, name))}`);
    return `${comment(v.description, "    ")}    ${k}: ${req.has(k) ? type : `NotRequired[${type}]`}`;
  });
  // An open object (additionalProperties) has more fields than it names: PEP 728 lets the caller read them.
  const open = s.additionalProperties !== undefined && s.additionalProperties !== false;
  out.push(`class ${name}(TypedDict${open ? ", extra_items=Any" : ""}):\n${docstring(s.description, "    ")}${fields.join("\n")}\n\n\n`);
  exported.push(name);
  return name;
}

/** Python args for one method: path params first, then the body, then query params as keywords, then request options. */
function signature(op, base) {
  const args = ["self", ...op.pathParams.map((p) => `${ident(p.name, base)}: str`)];
  if (op.body) args.push(`body: ${base}Body`);
  const query = op.query.filter((p) => p.name !== "cursor" || !op.paginated);
  const taken = new Set([...RESERVED, ...op.pathParams.map((p) => p.name)]);
  if (query.length) args.push("*");
  for (const p of query) {
    if (taken.has(ident(p.name, base))) throw new Error(`${base}: query param "${p.name}" clashes with another argument`);
    const type = py(p.schema, `${base}${pascal(p.name)}`);
    args.push(p.required ? `${p.name}: ${type}` : `${p.name}: ${type.startsWith("Optional[") ? type : `Optional[${type}]`} = None`);
  }
  args.push("**options: Unpack[RequestOptions]");
  return { args, query };
}

function method(op, async) {
  const base = pascal(`${op.resource}_${op.verb}`);
  const { args, query } = signature(op, base);
  let path = op.path;
  for (const p of op.pathParams) path = path.replace(`{${p.wire}}`, `{quote(${p.name}, safe='')}`);
  path = op.pathParams.length ? `f"${path}"` : `"${path}"`;
  const queryDict = `{${query.map((p) => `"${p.name}": ${p.name}`).join(", ")}}`;
  const page = async ? "AsyncPage" : "SyncPage";
  const final = op.status === 204 ? "None" : op.response ?? "Any";
  const head = (name, ret) => {
    const start = `def ${ident(name, base)}(`;
    const oneLine = `    ${start}${args.join(", ")}) -> ${ret}:`;
    return oneLine.length <= 110 ? oneLine : `    ${start}\n${args.map((a) => `        ${a},`).join("\n")}\n    ) -> ${ret}:`;
  };
  const init = [query.length ? `query=${queryDict}` : null, op.body ? "body=body" : null, "options=options"].filter(Boolean).join(", ");
  // The runtime returns parsed JSON as Any. A cast names the type the spec promises.
  const ret = (type, call) => (type === "None" ? call : type === "Any" ? `return ${call}` : `return cast(${type}, ${call})`);
  const params = query.filter((p) => p.description ?? p.schema.description).map((p) => `\n        ${p.name}: ${p.description ?? p.schema.description}`);
  const docs = `        """${escape(op.summary)} \`${op.httpMethod} ${op.path}\`${params.length ? `\n${params.join("")}\n        ` : ""}"""`;
  const call = (fn) => `${async ? "await " : ""}self._core.${fn}("${op.httpMethod}", ${path}, ${init})`;
  const methods = [];
  if (op.paginated) {
    methods.push([head(op.verb, `${page}[${op.item ?? "Any"}, ${op.response ?? "Any"}]`), docs, `        return self._core.list(${path}, ${queryDict}, options)`]);
  } else {
    const type = op.accepted ? `Union[${final}, ${op.accepted}]` : final;
    methods.push([head(op.verb, type), docs, `        ${ret(type, call("request"))}`]);
  }
  if (op.accepted) {
    // A 202 reply says the work is still running. The _and_wait method follows it to the final reply.
    methods.push([head(`${op.verb}_and_wait`, final), `        """Like \`${op.verb}\`, but waits while the work runs, then returns the ${final}."""`, `        ${ret(final, call("wait"))}`]);
  }
  const text = methods.map((m) => m.join("\n")).join("\n\n");
  return async && !op.paginated ? text.replaceAll(`    def `, `    async def `) : text;
}

// Named types: each component schema, then each request body. py() writes them as it goes.
// A named enum becomes a Literal alias. A named object becomes a TypedDict.
for (const [name, schema] of Object.entries(ir.schemas)) {
  if (schema.type === "object") {
    if (py(schema, name) !== name) throw new Error(`${name}: the object schema must have properties`);
  } else {
    out.push(`${comment(schema.description, "")}${name} = ${py(schema, name)}\n\n\n`);
    exported.push(name);
  }
}
for (const op of ir.operations) {
  const name = `${pascal(`${op.resource}_${op.verb}`)}Body`;
  if (op.body && py(op.body, name) !== name) throw new Error(`${name}: the body must be an object`);
}

for (const async of [false, true]) {
  for (const resource of ir.resources) {
    const name = `${async ? "Async" : ""}${pascal(resource)}Resource`;
    const ops = ir.operations.filter((o) => o.resource === resource);
    out.push(`class ${name}(${async ? "AsyncResource" : "SyncResource"}):\n${ops.map((o) => method(o, async)).join("\n\n")}\n\n\n`);
    exported.push(name);
  }
}

for (const async of [false, true]) {
  const name = async ? "AsyncFrontmost" : "Frontmost";
  const props = ir.resources.map((r) => `    @cached_property\n    def ${ident(r, name)}(self) -> ${async ? "Async" : ""}${pascal(r)}Resource:\n        return ${async ? "Async" : ""}${pascal(r)}Resource(self)`);
  const how = async ? "`AsyncFrontmost()` reads FRONTMOST_API_KEY. Use `await` and `async for`." : "`Frontmost()` reads FRONTMOST_API_KEY.";
  out.push(`class ${name}(${async ? "AsyncCore" : "SyncCore"}):\n    """The Frontmost AI client. ${how}"""\n\n${props.join("\n\n")}\n\n\n`);
  exported.push(name);
}

const body = out.join("").replace(/\n\n\n$/, "\n");
// Import only the typing names the file uses, so linters stay quiet.
const TYPING = ["Any", "Literal", "Optional", "Union", "cast"].filter((n) => new RegExp(`\\b${n}\\b`).test(body));
const header = [
  `# Generated by codegen/python.mjs from spec/openapi.json (${ir.title} ${ir.apiVersion}). Do not edit.`,
  "",
  "from functools import cached_property",
  `from typing import ${TYPING.join(", ")}`,
  "from urllib.parse import quote",
  "",
  "from typing_extensions import NotRequired, TypedDict, Unpack",
  "",
  "from ._core import AsyncCore, AsyncPage, AsyncResource, RequestOptions, SyncCore, SyncPage, SyncResource",
  "",
  "",
].join("\n");

const all = `\n\n__all__ = [\n${exported.map((n) => `    "${n}",`).join("\n")}\n]\n`;
writeFileSync(OUT, header + body + all);
const fmt = spawnSync("uvx", [RUFF, "format", "--quiet", "--config", fileURLToPath(new URL("../python/pyproject.toml", import.meta.url)), OUT], { stdio: "inherit" });
if (fmt.status !== 0) throw new Error("ruff format failed on _generated.py. Install uv: https://docs.astral.sh/uv/");
console.log(`python/src/frontmost/_generated.py: ${ir.operations.length} operations, ${exported.length} names`);
