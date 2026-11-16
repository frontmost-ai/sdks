// Writes rust/src/generated.rs from the shared operation list. Run: node codegen/rust.mjs
// The output is a pure function of spec/openapi.json, so CI can regenerate it and fail on any diff.
// rustfmt formats the file after writing, so the output matches `cargo fmt`.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load, nullable, pascal } from "./ir.mjs";

const ir = load();
const OUT = fileURLToPath(new URL("../rust/src/generated.rs", import.meta.url));
const KEYWORDS = new Set(["as", "async", "await", "box", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "override", "priv", "pub", "ref", "return", "self", "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while", "yield"]);

/** Every struct and enum, by name, in the order first seen. A name used twice must hold the same code. */
const defs = new Map();
function define(name, code) {
  if (defs.has(name) && defs.get(name) !== code) throw new Error(`Two different types want the name ${name}.`);
  defs.set(name, code);
  return name;
}

const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-.\s]/g, "_").toLowerCase();
const doc = (text, indent = "") => (text ? text.split("\n").map((l) => `${indent}/// ${l}`.trimEnd()).join("\n") + "\n" : "");
const field = (wire) => {
  const name = snake(wire);
  return { name: KEYWORDS.has(name) ? `r#${name}` : name, rename: name === wire ? null : wire };
};

/** The code of a string enum. Every enum reads a value it does not know as `Unknown`, because lists of values can grow. */
function enumCode(name, values, description) {
  const variants = values.map((v) => {
    // A Rust name cannot start with a digit, so "7d" is V7d.
    const variant = pascal(snake(String(v))).replace(/^(\d)/, "V$1");
    const attr = snake(variant) === v ? "" : `    #[serde(rename = ${JSON.stringify(v)})]\n`;
    return `${attr}    ${variant},`;
  });
  return `${doc(description)}#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]\n#[serde(rename_all = "snake_case")]\npub enum ${name} {\n${variants.join("\n")}\n    /// A value this SDK version does not know yet.\n    #[serde(other)]\n    Unknown,\n}`;
}

/** An unnamed string enum. Named after its field (`CompareTo`) when that name is free or holds the same values, else after its parent too. */
function enumType(values, fieldName, ctx) {
  const short = pascal(fieldName);
  if (!defs.has(short) || defs.get(short) === enumCode(short, values)) return define(short, enumCode(short, values));
  return define(ctx, enumCode(ctx, values));
}

/** One JSON Schema to one Rust type. Objects with properties become named structs. `ctx` names them. */
function rs(schema, ctx, fieldName = ctx) {
  if (!schema || Object.keys(schema).length === 0) return "serde_json::Value";
  const n = nullable(schema);
  if (n.nullable) return `Option<${rs(n.schema, ctx, fieldName)}>`;
  const s = n.schema;
  if (s.$ref) return s.$ref.split("/").at(-1);
  if (s.anyOf || s.oneOf || Array.isArray(s.type)) return "serde_json::Value";
  if (s.enum && s.type === "string") return enumType(s.enum, fieldName, ctx);
  switch (s.type) {
    case "string": return "String";
    case "integer": return "i64";
    case "number": return "f64";
    case "boolean": return "bool";
    case "array": return `Vec<${rs(s.items, ctx.endsWith("s") ? ctx.slice(0, -1) : `${ctx}Item`)}>`;
    case "object":
      if (!s.properties || Object.keys(s.properties).length === 0) return "serde_json::Map<String, serde_json::Value>";
      return struct(ctx, s);
    default: return "serde_json::Value";
  }
}

/** Fields the caller may leave out are `Option` and skipped when `None`. Response structs accept unknown fields. */
function struct(name, s, fields = Object.entries(s.properties ?? {}).map(([wire, v]) => ({ wire, schema: v, required: (s.required ?? []).includes(wire) }))) {
  let defaultable = true;
  const lines = fields.map(({ wire, schema, required, description }) => {
    const f = field(wire);
    let type = rs(schema, `${name}${pascal(snake(wire))}`, wire);
    const attrs = [];
    if (f.rename) attrs.push(`rename = ${JSON.stringify(f.rename)}`);
    if (!required) {
      type = `Option<${type}>`;
      attrs.push(`default`, `skip_serializing_if = "Option::is_none"`);
    } else if (!/^(Option|Vec)<|^(String|i64|f64|bool|serde_json::)/.test(type)) {
      defaultable = false;
    }
    const attr = attrs.length ? `    #[serde(${attrs.join(", ")})]\n` : "";
    return `${doc(description ?? schema.description, "    ")}${attr}    pub ${f.name}: ${type},`;
  });
  const derives = ["Debug", "Clone", "PartialEq", ...(defaultable ? ["Default"] : []), "Serialize", "Deserialize"];
  return define(name, `${doc(s.description)}#[derive(${derives.join(", ")})]\npub struct ${name} {\n${lines.join("\n")}\n}`);
}

for (const [name, schema] of Object.entries(ir.schemas)) {
  if (schema.type === "object" && schema.properties) struct(name, schema);
  else if (schema.type === "string" && schema.enum) define(name, enumCode(name, schema.enum, schema.description));
  else define(name, `${doc(schema.description)}pub type ${name} = ${rs(schema, name)};`);
}

/** The reply of an operation that can also answer 202: the final reply, or the reply that says to wait. */
function eitherType(op) {
  const name = `${pascal(`${op.resource}_${op.verb}`)}Reply`;
  const code = [
    `/// The reply of \`${op.resource}().${op.verb}()\`: the ${op.response}, or ${op.accepted} while the work runs.`,
    `#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]`,
    `#[serde(untagged)]`,
    `pub enum ${name} {`,
    `    ${op.response}(${op.response}),`,
    `    ${op.accepted}(${op.accepted}),`,
    `}`,
  ].join("\n");
  return define(name, code);
}

/** Query params minus `cursor`, which `Page` sends. Returns the struct name, or null when there are none. */
function paramsType(op) {
  const props = op.query.filter((p) => p.name !== "cursor" || !op.paginated);
  if (props.length === 0) return null;
  const name = `${pascal(`${op.resource}_${op.verb}`)}Params`;
  struct(name, {}, props.map((p) => ({ wire: p.name, schema: p.schema, required: p.required, description: p.description ?? p.schema.description })));
  return { name, required: props.some((p) => p.required) };
}

const methods = new Map(ir.resources.map((r) => [r, []]));
for (const op of ir.operations) {
  const base = pascal(`${op.resource}_${op.verb}`);
  const params = paramsType(op);
  const body = op.body ? rs(op.body, `${base}Body`) : null;
  const args = ["&self", ...op.pathParams.map((p) => `${field(p.name).name}: &str`)];
  if (body) args.push(`body: ${body}`);
  if (params) args.push(`params: ${params.required ? params.name : `Option<${params.name}>`}`);
  args.push("options: Option<RequestOptions>");

  let fmt = op.path;
  for (const p of op.pathParams) fmt = fmt.replace(`{${p.wire}}`, "{}");
  const path = op.pathParams.length ? `&format!(${JSON.stringify(fmt)}, ${op.pathParams.map((p) => `encode(${field(p.name).name})`).join(", ")})` : JSON.stringify(op.path);
  const query = params ? "to_json(&params)" : "serde_json::Value::Null";

  const lines = [`    /// ${op.summary} \`${op.httpMethod} ${op.path}\``];
  const bodyArg = body ? "Some(to_json(&body))" : "None";
  if (op.paginated) {
    const item = op.item ?? "serde_json::Value";
    lines.push(`    pub fn ${op.verb}(${args.join(", ")}) -> Page<${item}${op.response ? `, ${op.response}` : ""}> {`);
    lines.push(`        Page::new(self.client, ${path.startsWith("&") ? path.slice(1) : `${path}.to_string()`}, ${query}, options)`);
  } else {
    const final = op.status === 204 ? "()" : op.response ?? "serde_json::Value";
    const ret = op.accepted ? eitherType(op) : final;
    lines.push(`    pub async fn ${op.verb}(${args.join(", ")}) -> Result<${ret}, Error> {`);
    lines.push(`        self.client.request(Method::${op.httpMethod}, ${path}, ${params ? `Some(${query})` : "None"}, ${bodyArg}, options).await`);
    if (op.accepted) {
      // A 202 reply says the work is still running. The _and_wait method follows it to the final reply.
      lines.push("    }", "", `    /// Like \`${op.verb}\`, but waits while the work runs, then returns the ${final}.`);
      lines.push(`    pub async fn ${op.verb}_and_wait(${args.join(", ")}) -> Result<${final}, Error> {`);
      lines.push(`        self.client.wait(Method::${op.httpMethod}, ${path}, ${bodyArg}, options).await`);
    }
  }
  lines.push("    }");
  methods.get(op.resource).push(lines.join("\n"));
}

const out = [];
out.push(`// Generated by codegen/rust.mjs from spec/openapi.json (${ir.title} ${ir.apiVersion}). Do not edit.`);
out.push(`use reqwest::Method;`, `use serde::{Deserialize, Serialize};`, "", `use crate::core::{encode, to_json, Client, Error, Page, RequestOptions};`, "");
for (const code of defs.values()) out.push(code, "");

for (const resource of ir.resources) {
  const name = `${pascal(resource)}Resource`;
  out.push(`#[derive(Debug, Clone, Copy)]`, `pub struct ${name}<'a> {`, `    client: &'a Client,`, `}`, "");
  out.push(`impl ${name}<'_> {`, methods.get(resource).join("\n\n"), `}`, "");
}

out.push(`impl Client {`);
out.push(ir.resources.map((r) => `    pub fn ${snake(r)}(&self) -> ${pascal(r)}Resource<'_> {\n        ${pascal(r)}Resource { client: self }\n    }`).join("\n\n"));
out.push(`}`, "");

writeFileSync(OUT, out.join("\n"));
const fmt = spawnSync("rustfmt", ["--edition", "2021", OUT], { stdio: "inherit" });
if (fmt.status !== 0) throw new Error("rustfmt failed on rust/src/generated.rs. Install it with `rustup component add rustfmt`.");
console.log(`rust/src/generated.rs: ${ir.operations.length} operations, ${defs.size} types`);
