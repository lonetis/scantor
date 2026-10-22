import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const CHECK_JS = fileURLToPath(new URL("../check.js", import.meta.url));
const dirs: string[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function check(files: Record<string, string>, entry: string): { status: number | null; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "scantor-js-check-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const result = spawnSync(process.execPath, ["--conditions=scantor-source", CHECK_JS, entry], { cwd: dir, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout };
}

const PACKAGE = '{"type":"module","private":true}';

describe("SCANTOR_CHECK_CMD", () => {
  test("type errors of a TypeScript task are reported as file:line:column lines (default options)", () => {
    const { status, stdout } = check({ "package.json": PACKAGE, "main.ts": 'const text: string = 42;\nexport default text;\n' }, "main.ts");
    assert.equal(status, 1);
    assert.match(stdout, /^main\.ts:1:7: TS2322: /m);
  });

  test("a clean task exits 0; Node's types are available by default", () => {
    const main = "import { join } from \"node:path\";\nexport const text: string = join(process.cwd(), 'ok');\n";
    const { status, stdout } = check({ "package.json": PACKAGE, "main.ts": main }, "main.ts");
    assert.deepEqual([status, stdout], [0, ""]);
  });

  test("jsconfig.json with checkJs checks JavaScript", () => {
    const files = {
      "package.json": PACKAGE,
      "jsconfig.json": '{"compilerOptions":{"checkJs":true,"strict":true,"noEmit":true,"module":"nodenext","skipLibCheck":true}}',
      "main.js": "// @ts-check\n/** @type {number} */\nexport const n = 'x';\n",
    };
    const { status, stdout } = check(files, "main.js");
    assert.equal(status, 1);
    assert.match(stdout, /^main\.js:3:14: TS2322: /m);
  });

  test("tsconfig problems without a location are attributed to tsconfig.json", () => {
    const files = { "package.json": PACKAGE, "tsconfig.json": '{"compilerOptions":{"target":"es1"}}', "main.ts": "export {};\n" };
    const { status, stdout } = check(files, "main.ts");
    assert.equal(status, 1);
    assert.match(stdout, /^tsconfig\.json:\d+(:\d+)?: TS\d+: /m);
  });

  test("a missing entry is a warning, not an error", () => {
    const { status, stdout } = check({ "package.json": PACKAGE }, "main.ts");
    assert.equal(status, 0);
    assert.match(stdout, /^warning: main\.ts is not in the image/);
  });
});
