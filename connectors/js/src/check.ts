// SCANTOR_CHECK_CMD: `node /node_modules/@scantor/connector/check.js {entry}` calls main().
// Runs `tsc --noEmit` in /task and prints every error as `<file>:<line>:<column>: <message>`
// (docs/tasks.md §4.2); other output passes through and becomes log lines.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";

/**
 * Used when the task has neither tsconfig.json nor jsconfig.json; the same options as the scaffolds.
 * TypeScript 6 includes no @types package unless `types` names it.
 */
const DEFAULT_TS_OPTIONS = [
  "--target", "es2024",
  "--module", "nodenext",
  "--moduleResolution", "nodenext",
  "--types", "node",
  "--strict",
  "--allowImportingTsExtensions",
  "--erasableSyntaxOnly",
  "--verbatimModuleSyntax",
  "--skipLibCheck",
];
const DEFAULT_JS_OPTIONS = [
  "--target", "es2024",
  "--module", "nodenext",
  "--moduleResolution", "nodenext",
  "--types", "node",
  "--allowJs",
  "--checkJs",
  "--strict",
  "--skipLibCheck",
];

const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+: .*)$/;
const GLOBAL_DIAGNOSTIC = /^error (TS\d+: .*)$/;

interface Invocation {
  args: string[];
  /** The file global diagnostics (no location) are attributed to. */
  anchor: string;
}

const require = createRequire(import.meta.url);

function invocation(entry: string): Invocation {
  for (const configFile of ["tsconfig.json", "jsconfig.json"]) {
    if (existsSync(configFile)) return { args: ["--project", configFile], anchor: configFile };
  }
  const isTypeScript = [".ts", ".mts", ".cts"].includes(extname(entry));
  // The @types next to the type checker (the image's /node_modules/@types), wherever the task lives.
  const typeRoot = dirname(dirname(require.resolve("@types/node/package.json")));
  const options = isTypeScript ? DEFAULT_TS_OPTIONS : DEFAULT_JS_OPTIONS;
  return { args: [...options, "--typeRoots", typeRoot, entry], anchor: entry };
}

/** tsc continues long messages on indented lines; each error becomes exactly one output line. */
export function normalize(output: string, anchor: string): string[] {
  const lines: string[] = [];
  let current: string | undefined;
  const flush = (): void => {
    if (current !== undefined) lines.push(current);
    current = undefined;
  };
  for (const raw of output.split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;
    if (current !== undefined && /^\s/.test(raw)) {
      current += ` ${raw.trim()}`;
      continue;
    }
    flush();
    const located = DIAGNOSTIC.exec(raw);
    const global = GLOBAL_DIAGNOSTIC.exec(raw);
    if (located !== null) current = `${located[1]}:${located[2]}:${located[3]}: ${located[4]}`;
    else if (global !== null) current = `${anchor}:1: ${global[1]}`;
    else lines.push(raw);
  }
  flush();
  return lines;
}

export function main(): void {
  const entry = process.argv[2];
  if (entry === undefined || entry.length === 0) {
    process.stderr.write("scantor check: usage: check.js <entry>\n");
    process.exit(2);
  }
  if (!existsSync(resolve(entry))) {
    process.stdout.write(`warning: ${entry} is not in the image; type check skipped\n`);
    process.exit(0);
  }
  const tsc = require.resolve("typescript/bin/tsc");
  const { args, anchor } = invocation(entry);
  const child = spawn(process.execPath, [tsc, ...args, "--noEmit", "--pretty", "false"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  child.on("error", (error) => {
    process.stderr.write(`scantor check: cannot run tsc: ${error.message}\n`);
    process.exit(2);
  });
  child.on("close", (code) => {
    const lines = normalize(output, anchor);
    if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
    process.exit(code === 0 ? 0 : 1);
  });
}
