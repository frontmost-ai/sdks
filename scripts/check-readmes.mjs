// Type-checks every code example in the READMEs, and typescript/examples, against the SDK source. Run: node scripts/check-readmes.mjs
// Each example becomes one function. A shared prelude gives it `client` and a question `body`.
// Exit code 1 if an example does not compile.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const read = (path) => readFileSync(`${root}${path}`, "utf8");

/** The fenced blocks of one language in one Markdown file. */
const blocks = (markdown, lang) => [...markdown.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g"))].map((m) => m[1]);
const examples = (lang, readme) => [...blocks(read("README.md"), lang), ...blocks(read(readme), lang)];
const indent = (code, pad) => code.split("\n").map((line) => (line ? pad + line : line)).join("\n");
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd: `${root}${cwd}`, stdio: "inherit" }).status === 0;

function typescript() {
  const names = new Set();
  const bodies = examples("ts", "typescript/README.md").map((code, i) => {
    const rest = code.replace(/^import (?:Frontmost, )?\{([^}]*)\} from "@frontmost-ai\/sdk";\n/gm, (_, list) => {
      for (const name of list.split(",")) names.add(name.trim());
      return "";
    });
    return `export async function example${i}() {\n${indent(rest.replace(/^import .*\n/gm, ""), "  ")}}\n`;
  });
  names.delete("");
  const file = [
    `import Frontmost, { ${[...names, "type QuestionsCreateBody"].join(", ")} } from "@frontmost-ai/sdk";`,
    `const client = new Frontmost();`,
    `const body: QuestionsCreateBody = { questions: [{ text: "Which bank is best for students?" }] };`,
    ...bodies,
  ].join("\n");
  mkdirSync(`${root}typescript/.readme`, { recursive: true });
  writeFileSync(`${root}typescript/.readme/examples.ts`, file);
  writeFileSync(
    `${root}typescript/.readme/tsconfig.json`,
    JSON.stringify({
      extends: "../tsconfig.json",
      compilerOptions: { noEmit: true, rootDir: "..", paths: { "@frontmost-ai/sdk": ["../src/index.ts"] } },
      include: ["../src", "../examples", "examples.ts"],
    }),
  );
  const ok = run("npx", ["tsc", "-p", ".readme"], "typescript");
  rmSync(`${root}typescript/.readme`, { recursive: true, force: true });
  return ok;
}

function python() {
  const imports = new Set(["from frontmost import Frontmost, QuestionsCreateBody"]);
  const bodies = examples("python", "python/README.md").map((code, i) => {
    const rest = code.replace(/^(?:import|from) .*\n/gm, (line) => (imports.add(line.trim()), ""));
    return `def example${i}() -> None:\n${indent(rest, "    ")}\n`;
  });
  const file = [
    ...imports,
    "",
    "client = Frontmost()",
    'body: QuestionsCreateBody = {"questions": [{"text": "Which bank is best for students?"}]}',
    "",
    ...bodies,
  ].join("\n");
  writeFileSync(`${root}python/readme_examples.py`, file);
  const ok = run("uv", ["run", "--quiet", "--with", "mypy", "mypy", "--strict", "readme_examples.py"], "python");
  rmSync(`${root}python/readme_examples.py`, { force: true });
  return ok;
}

function rust() {
  const bodies = examples("rust", "rust/README.md").map((code, i) => {
    if (/fn main\(\)/.test(code)) return code.replace("#[tokio::main]\n", "").replace("fn main()", `fn example${i}()`);
    const body = `async fn example${i}(client: Client, body: QuestionsCreateBody) -> Result<(), Error> {\n${indent(code, "    ")}    Ok(())\n}\n`;
    return `#[allow(unused_imports, unused_variables, clippy::all)]\n${body}`;
  });
  const file = [
    "#![allow(dead_code)]",
    "use frontmost_ai::*;",
    "use futures::StreamExt;",
    "fn main() {}",
    ...bodies,
  ].join("\n");
  writeFileSync(`${root}rust/examples/readme_check.rs`, file);
  const ok = run("cargo", ["check", "--quiet", "--example", "readme_check"], "rust");
  rmSync(`${root}rust/examples/readme_check.rs`, { force: true });
  return ok;
}

const results = { typescript: typescript(), python: python(), rust: rust() };
for (const [lang, ok] of Object.entries(results)) console.log(`${ok ? "PASS" : "FAIL"}  ${lang} README examples`);
process.exit(Object.values(results).every(Boolean) ? 0 : 1);
