// The TypeScript and JavaScript example tasks (tasks/) and their guides (docs/guide/) against the
// connector installed in the base image, as the runtime would serve them.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { parse as parseYaml } from "yaml";
import { FakeRuntime, NEEDS_INSTALLED_CONNECTOR, type Message } from "./helpers/runtime.ts";
import { readJson, repoRoot, validateManifest } from "./helpers/schemas.ts";
import { typeCheck } from "./helpers/tasks.ts";

interface Example {
  name: string;
  language: "typescript" | "javascript";
  entry: string;
  typeConfig: string;
}

const EXAMPLES: Example[] = [
  { name: "http-status", language: "typescript", entry: "main.ts", typeConfig: "tsconfig.json" },
  { name: "power", language: "javascript", entry: "main.js", typeConfig: "jsconfig.json" },
];
const GUIDES = ["authoring-typescript.md", "authoring-javascript.md"];
const MINIMAL_DOCKERFILE =
  "ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY package.json package-lock.json ./\nRUN npm ci --omit=dev\nCOPY . .\n";

const folderOf = (name: string): string => join(repoRoot, "tasks", name);
const read = (path: string): string => readFileSync(path, "utf8");
const readJsonFile = (path: string): Record<string, any> => JSON.parse(read(path)) as Record<string, any>;

/** A loopback port nothing listens on. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const runtimes: FakeRuntime[] = [];

async function serve(example: string): Promise<FakeRuntime> {
  const runtime = await FakeRuntime.ready(EXAMPLES.find((candidate) => candidate.name === example)!.entry, {}, {
    cwd: folderOf(example),
    installed: true,
  });
  runtimes.push(runtime);
  return runtime;
}

async function describeTask(runtime: FakeRuntime): Promise<Message> {
  runtime.send({ type: "describe", id: "d1" });
  const description = await runtime.reply("d1");
  assert.equal(description.type, "description", JSON.stringify(description));
  return description;
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    assert.deepEqual(runtime.violations, [], "every line on fd 4 validates against connectorToRuntime");
    runtime.cleanup();
  }
});

describe("example folders", () => {
  for (const example of EXAMPLES) {
    test(`${example.name} follows the task folder structure`, () => {
      const folder = folderOf(example.name);
      const manifest = parseYaml(read(join(folder, "scantor.yaml"))) as Record<string, unknown>;
      assert.ok(validateManifest(manifest), JSON.stringify(validateManifest.errors));
      assert.equal(manifest.name, example.name);
      assert.equal(manifest.language, example.language);
      assert.equal(manifest.entry ?? example.entry, example.entry);
      assert.ok(existsSync(join(folder, example.entry)));
      assert.equal(read(join(folder, "Dockerfile")), MINIMAL_DOCKERFILE);
      assert.equal(read(join(folder, ".dockerignore")), read(join(repoRoot, "scaffolds", example.language, "files/.dockerignore")));
      const scaffoldConfig = join(repoRoot, "scaffolds", example.language, "files", example.typeConfig);
      assert.deepEqual(readJsonFile(join(folder, example.typeConfig)), readJsonFile(scaffoldConfig));

      const packageJson = readJsonFile(join(folder, "package.json"));
      assert.equal(packageJson.type, "module");
      const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
      assert.ok(!("zod" in dependencies) && !("@scantor/connector" in dependencies), "zod and the connector come from the base image");
      assert.equal(readJsonFile(join(folder, "package-lock.json")).name, packageJson.name);
    });

    test(`${example.name} type-checks with SCANTOR_CHECK_CMD`, { skip: NEEDS_INSTALLED_CONNECTOR }, () => {
      const { status, output } = typeCheck(folderOf(example.name), example.entry);
      assert.deepEqual([status, output], [0, ""]);
    });
  }
});

describe("http-status", { skip: NEEDS_INSTALLED_CONNECTOR }, () => {
  let server: Server;
  let base = "";

  before(async () => {
    server = createServer((request, response) => {
      switch (request.url) {
        case "/":
          response.writeHead(200, { "content-type": "text/plain" }).end("ok");
          return;
        case "/moved":
          response.writeHead(301, { location: "/" }).end();
          return;
        case "/limited":
          response.writeHead(429, { "retry-after": "7" }).end();
          return;
        case "/silent":
          return; // never answers
        default:
          response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  test("describes the unwrapped crux template", async () => {
    const description = await describeTask(await serve("http-status"));
    assert.deepEqual(description.schedule, { kind: "template", template: "crux" });
    assert.deepEqual(description.warnings, []);
    const taskConfig = description.schemas.taskConfig;
    assert.equal(taskConfig.properties.expectedStatus.default, 200);
    assert.equal(taskConfig.additionalProperties, false);
    const canonical = readJson<Record<string, any>>("templates/crux.json").$defs.analysisConfig;
    assert.deepEqual(description.schemas.analysisConfig.properties, canonical.properties);
  });

  test("checks the status against expectedStatus", async () => {
    const runtime = await serve("http-status");
    const ok = await runtime.reply(runtime.run({ origin: base, rank: 1000 }));
    assert.equal(ok.type, "result", JSON.stringify(ok));
    assert.deepEqual({ ...ok.result, durationMs: 0 }, {
      origin: base,
      rank: 1000,
      status: 200,
      matches: true,
      finalUrl: `${base}/`,
      durationMs: 0,
      error: null,
    });

    const missing = await runtime.reply(runtime.run({ origin: `${base}/gone`, rank: 1000 }));
    assert.deepEqual([missing.result.status, missing.result.matches], [404, false]);

    const expected404 = await runtime.reply(runtime.run({ origin: `${base}/gone`, rank: 1000 }, { expectedStatus: 404 }));
    assert.equal(expected404.result.matches, true);

    const redirected = await runtime.reply(runtime.run({ origin: `${base}/moved`, rank: 5000 }));
    assert.deepEqual([redirected.result.status, redirected.result.finalUrl], [200, `${base}/`]);
    const manual = await runtime.reply(runtime.run({ origin: `${base}/moved`, rank: 5000 }, { followRedirects: false }));
    assert.deepEqual([manual.result.status, manual.result.matches], [301, false]);
  });

  test("a rate limit is retried after Retry-After; unreachable origins are results", async () => {
    const runtime = await serve("http-status");
    const limited = await runtime.reply(runtime.run({ origin: `${base}/limited`, rank: 1000 }));
    assert.equal(limited.type, "error");
    assert.deepEqual([limited.error.type, limited.error.delayMs], ["retry", 7000]);

    const refused = await runtime.reply(runtime.run({ origin: `http://127.0.0.1:${await closedPort()}`, rank: 1000 }));
    assert.equal(refused.result.status, null);
    assert.equal(refused.result.matches, false);
    assert.match(refused.result.error, /ECONNREFUSED/);

    const silent = await runtime.reply(runtime.run({ origin: `${base}/silent`, rank: 1000 }, { timeoutMs: 1000 }));
    assert.deepEqual([silent.result.status, silent.result.error], [null, "no response within 1000 ms"]);
  });

  test("the analysis deadline cancels the request", async () => {
    const runtime = await serve("http-status");
    const id = runtime.run({ origin: `${base}/silent`, rank: 1000 }, {}, { deadlineMs: Date.now() + 300 });
    const reply = await runtime.reply(id);
    assert.deepEqual(reply.error, { type: "cancelled", message: "deadline exceeded" });
  });
});

describe("power", { skip: NEEDS_INSTALLED_CONNECTOR }, () => {
  test("describes a custom schedule", async () => {
    const description = await describeTask(await serve("power"));
    assert.deepEqual(description.schedule, { kind: "custom" });
    assert.deepEqual(Object.keys(description.schemas.scanConfig.properties), ["start", "end", "onlyOdd"]);
    assert.deepEqual(description.warnings, []);
  });

  test("the schedule wraps the range template and can skip even bases", async () => {
    const runtime = await serve("power");
    const values = (from: number, to: number): Message[] => Array.from({ length: to - from }, (_, index) => ({ value: from + index }));

    const all = runtime.schedule({});
    const [report, { configs, end }] = await Promise.all([runtime.serveTemplate(values(1, 11)), runtime.collect(all)]);
    assert.deepEqual(report.request.scanConfig, { start: 1, end: 11, step: 1 });
    assert.deepEqual(configs, values(1, 11).map((item) => ({ base: item.value })));
    assert.deepEqual(end, { type: "done", id: all, count: 10 });

    const odd = runtime.schedule({ start: -3, end: 4, onlyOdd: true });
    const [oddReport, oddRun] = await Promise.all([runtime.serveTemplate(values(-3, 4)), runtime.collect(odd)]);
    assert.deepEqual(oddReport.request.scanConfig, { start: -3, end: 4, step: 1 });
    assert.deepEqual(oddRun.configs, [{ base: -3 }, { base: -1 }, { base: 1 }, { base: 3 }]);
  });

  test("run computes exact powers, attaches reports and rejects negative bases", async () => {
    const runtime = await serve("power");
    const squared = await runtime.reply(runtime.run({ base: 12 }));
    assert.deepEqual(squared.result, { base: 12, power: "144", report: null });

    const big = await runtime.reply(runtime.run({ base: 2 }, { exponent: 64 }));
    assert.equal(big.result.power, "18446744073709551616");

    const id = runtime.run({ base: 3 }, { exponent: 3, report: true });
    const file = await runtime.next("file");
    assert.deepEqual([file.parent, file.name, file.contentType], [id, "report.txt", "text/plain"]);
    assert.equal(read(file.path), "3^3 = 27\n");
    const ref = runtime.answerFile(file);
    const withReport = await runtime.reply(id);
    assert.deepEqual(withReport.result, { base: 3, power: "27", report: ref });

    const negative = await runtime.reply(runtime.run({ base: -2 }));
    assert.deepEqual([negative.error.type, negative.error.message], ["fatal", "negative bases are not supported"]);
  });
});

/** `<!-- scantor:include <path> -->` blocks of a guide: the fenced code must equal the file. */
function includes(guide: string): { path: string; code: string }[] {
  const pattern = /<!-- scantor:include (\S+) -->\n```\w*\n([\s\S]*?)```\n<!-- scantor:include:end -->/g;
  return [...guide.matchAll(pattern)].map((match) => ({ path: match[1]!, code: match[2]! }));
}

describe("guides", () => {
  for (const name of GUIDES) {
    test(`${name} includes the examples verbatim`, () => {
      const guide = read(join(repoRoot, "docs/guide", name));
      const blocks = includes(guide);
      assert.ok(blocks.length > 0, "the guide includes at least one example");
      assert.equal(blocks.length, guide.split("<!-- scantor:include ").length - 1, "every include block is well-formed");
      for (const block of blocks) assert.equal(block.code, read(join(repoRoot, block.path)), block.path);
    });
  }
});
