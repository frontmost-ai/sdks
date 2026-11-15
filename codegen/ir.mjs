// Reads spec/openapi.json and returns one plain list of operations that every language emitter uses.
// Language emitters never read the OpenAPI file. One reader means one naming rule for TypeScript, Python, and Rust.

import { readFileSync } from "node:fs";

/** @typedef {{ name: string, in: "path" | "query", required: boolean, schema: any, description?: string }} Param */
/**
 * @typedef {{
 *   resource: string, method: string, verb: string, httpMethod: string, path: string, summary: string,
 *   pathParams: { name: string, wire: string }[], query: Param[], body: any | null,
 *   response: string | null, accepted: string | null, item: string | null, paginated: boolean, status: number
 * }} Operation
 */
// `accepted` names the 202 reply of an operation that can answer "still working". It carries `retry_after` and `next`.

const strip = ({ $schema, $id, ...rest }) => rest;
const refName = (schema) => (schema?.$ref ? schema.$ref.split("/").at(-1) : null);
const enumKey = (s) => (s?.type === "string" && Array.isArray(s.enum) ? JSON.stringify([...s.enum].sort()) : null);

/**
 * An inline string enum with the same values as a named enum becomes a reference to it,
 * so `period` in a query and `period.name` in a reply share one `Period` type.
 */
function shareEnums(schema, named) {
  if (Array.isArray(schema)) return schema.map((x) => shareEnums(x, named));
  if (!schema || typeof schema !== "object") return schema;
  const name = named.get(enumKey(schema));
  if (name) {
    const { type, enum: _, ...rest } = schema;
    return { $ref: `#/components/schemas/${name}`, ...rest };
  }
  return Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, shareEnums(v, named)]));
}

/** The API sends booleans in a query as the strings "true" and "false". The SDKs take a real boolean. */
const queryBoolean = (s) => (enumKey(s) === '["false","true"]' ? { type: "boolean", ...(s.description ? { description: s.description } : {}) } : s);
const singular = (noun) => noun.replace(/ies$/, "y").replace(/s$/, "");

/** `/projects/{id}/questions` has a project ID, so its `{id}` becomes `project_id` in method signatures. */
function pathParams(path) {
  const parts = path.split("/").filter(Boolean);
  const out = [];
  parts.forEach((p, i) => {
    if (!p.startsWith("{")) return;
    const wire = p.slice(1, -1);
    const last = i === parts.length - 1;
    out.push({ wire, name: wire === "id" && !last ? `${singular(parts[i - 1])}_id` : wire });
  });
  return out;
}

export function load(file = new URL("../spec/openapi.json", import.meta.url)) {
  const spec = JSON.parse(readFileSync(file, "utf8"));
  const raw = spec.components?.schemas ?? {};
  const named = new Map(Object.entries(raw).filter(([, v]) => enumKey(v)).map(([k, v]) => [enumKey(v), k]));
  const share = (s) => shareEnums(s, named);
  /** @type {Operation[]} */
  const operations = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [httpMethod, op] of Object.entries(methods)) {
      const [resource, verb] = op.operationId.split(".");
      const params = op.parameters ?? [];
      const json = (code) => op.responses[code]?.content?.["application/json"]?.schema;
      const okStatus = Object.keys(op.responses).find((c) => /^2/.test(c) && c !== "202");
      const response = refName(json(okStatus));
      const query = params.filter((p) => p.in === "query").map((p) => ({ ...p, schema: share(queryBoolean(strip(p.schema))) }));
      const paginated = query.some((p) => p.name === "cursor");
      const item = response && paginated ? refName(raw[response]?.properties?.data?.items) : null;
      operations.push({
        resource,
        verb,
        method: verb,
        httpMethod: httpMethod.toUpperCase(),
        path,
        summary: op.summary,
        pathParams: pathParams(path),
        query,
        body: op.requestBody ? share(strip(op.requestBody.content["application/json"].schema)) : null,
        response,
        accepted: okStatus === "202" ? null : refName(json("202")),
        item,
        paginated,
        status: Number(okStatus),
      });
    }
  }
  // A named enum keeps its own values. Every other schema refers to named enums by name.
  const schemas = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, enumKey(v) ? strip(v) : share(strip(v))]));
  const resources = [...new Set(operations.map((o) => o.resource))];
  return { title: spec.info.title, apiVersion: spec.info.version, schemas, resources, operations };
}

/** Splits a snake_case name into words, for each language's own case. */
export const words = (name) => name.split(/[_.-]/).filter(Boolean);
export const camel = (name) => words(name).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join("");
export const pascal = (name) => words(name).map((w) => w[0].toUpperCase() + w.slice(1)).join("");

/** The non-null options of a schema, and whether null is allowed. */
export function nullable(schema) {
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t) => t !== "null");
    return { schema: { ...schema, type: types.length === 1 ? types[0] : types }, nullable: types.length < schema.type.length };
  }
  if (schema.anyOf) {
    const real = schema.anyOf.filter((s) => s.type !== "null");
    const isNull = real.length < schema.anyOf.length;
    if (real.length === 1) return { schema: { description: schema.description, ...real[0] }, nullable: isNull };
    return { schema: { ...schema, anyOf: real }, nullable: isNull };
  }
  return { schema, nullable: false };
}

// `node codegen/ir.mjs` prints the operation list, which is the input every emitter reads.
if (import.meta.url === `file://${process.argv[1]}`) {
  const ir = load();
  for (const o of ir.operations) {
    const out = o.paginated ? `pages of ${o.item ?? "object"}` : [o.response ?? "object", o.accepted].filter(Boolean).join(" | ");
    console.log(`${o.resource}.${o.verb}(${o.pathParams.map((p) => p.name).join(", ")})  ${o.httpMethod} ${o.path} -> ${out}`);
  }
}
