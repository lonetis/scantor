// The TypeScript and JavaScript scaffolds (scaffolds/typescript, scaffolds/javascript): rendered like
// `scantor init` renders them, every entry must type-check, describe and run on the installed connector.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { parse as parseYaml } from "yaml";
import { FakeRuntime, NEEDS_INSTALLED_CONNECTOR, type Message } from "./helpers/runtime.ts";
import { readJson, repoRoot, TEMPLATE_NAMES, validateManifest } from "./helpers/schemas.ts";
import { render, typeCheck, type RenderData } from "./helpers/tasks.ts";

const LANGUAGES = [
  { language: "typescript", extension: "ts", typeConfig: "tsconfig.json" },
  { language: "javascript", extension: "js", typeConfig: "jsconfig.json" },
] as const;
type Language = (typeof LANGUAGES)[number];

const ENTRIES = [...TEMPLATE_NAMES, "custom"].sort();
const MINIMAL_DOCKERFILE =
  "ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY package.json package-lock.json ./\nRUN npm ci --omit=dev\nCOPY . .\n";

function renderData(language: string, template: string): RenderData {
  return {
    Name: `m-${language}-test`,
    Description: 'A "quoted": description',
    Language: language,
    Template: template,
    Version: "1.4.0",
    BaseImage: "ghcr.io/lonetis/scantor-base-js:1.4.0",
    ManifestSchemaURL: "https://raw.githubusercontent.com/lonetis/scantor/v1.4.0/schemas/task-manifest.schema.json",
    GuideURL: `https://github.com/lonetis/scantor/blob/v1.4.0/docs/guide/authoring-${language}.md`,
  };
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const temporary: string[] = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

/** Renders the scaffold of `spec` with `template` into a new folder, as `scantor init` does. */
function scaffold(spec: Language, template: string): string {
  const root = join(repoRoot, "scaffolds", spec.language);
  const target = mkdtempSync(join(tmpdir(), `scantor-js-${spec.language}-${template}-`));
  temporary.push(target);
  const data = renderData(spec.language, template);
  for (const source of walk(join(root, "files"))) {
    const destination = join(target, relative(join(root, "files"), source)).replace(/\.tmpl$/, "");
    mkdirSync(dirname(destination), { recursive: true });
    if (source.endsWith(".tmpl")) writeFileSync(destination, render(readFileSync(source, "utf8"), data));
    else copyFileSync(source, destination);
  }
  const entry = readFileSync(join(root, "entry", `${template}.${spec.extension}.tmpl`), "utf8");
  writeFileSync(join(target, `main.${spec.extension}`), render(entry, data));
  return target;
}

const readJsonFile = (path: string): Record<string, any> => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

const runtimes: FakeRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    assert.deepEqual(runtime.violations, [], "every line on fd 4 validates against connectorToRuntime");
    runtime.cleanup();
  }
});

for (const spec of LANGUAGES) {
  describe(`scaffold ${spec.language}`, () => {
    test("has an entry for every template and custom", () => {
      const entries = readdirSync(join(repoRoot, "scaffolds", spec.language, "entry"))
        .map((file) => file.replace(`.${spec.extension}.tmpl`, ""))
        .sort();
      assert.deepEqual(entries, ENTRIES);
    });

    test("renders the task folder files", () => {
      const folder = scaffold(spec, "single");
      const data = renderData(spec.language, "single");
      const manifestText = readFileSync(join(folder, "scantor.yaml"), "utf8");
      assert.ok(manifestText.startsWith(`# yaml-language-server: $schema=${data.ManifestSchemaURL}\n`));
      const manifest = parseYaml(manifestText) as Record<string, unknown>;
      assert.ok(validateManifest(manifest), JSON.stringify(validateManifest.errors));
      assert.deepEqual(manifest, { scantor: 1, name: data.Name, language: spec.language, description: data.Description });
      const withoutDescription = render(
        readFileSync(join(repoRoot, "scaffolds", spec.language, "files/scantor.yaml.tmpl"), "utf8"),
        { ...data, Description: "" },
      );
      assert.ok(!("description" in (parseYaml(withoutDescription) as Record<string, unknown>)));

      assert.equal(readFileSync(join(folder, "Dockerfile"), "utf8"), MINIMAL_DOCKERFILE);
      assert.equal(readFileSync(join(folder, ".dockerignore"), "utf8"), ".git/\n.scantor/\nnode_modules/\n.DS_Store\n");
      assert.equal(readFileSync(join(folder, ".gitignore"), "utf8"), ".scantor/\nnode_modules/\n");

      const packageJson = readJsonFile(join(folder, "package.json"));
      assert.deepEqual(packageJson, { name: data.Name, private: true, type: "module" });
      assert.equal(readJsonFile(join(folder, "package-lock.json")).packages[""].name, data.Name);

      const options = readJsonFile(join(folder, spec.typeConfig)).compilerOptions;
      assert.equal(options.strict, true);
      assert.equal(options.noEmit, true);
      assert.equal(options.module, "nodenext");
      if (spec.language === "typescript") {
        for (const flag of ["allowImportingTsExtensions", "erasableSyntaxOnly", "verbatimModuleSyntax", "skipLibCheck"]) {
          assert.equal(options[flag], true, flag);
        }
        assert.equal(options.target, "es2024");
      } else {
        assert.equal(options.checkJs, true);
        assert.match(readFileSync(join(folder, "main.js"), "utf8"), /^\/\/ @ts-check\n/);
      }

      const devcontainer = readJsonFile(join(folder, ".devcontainer/devcontainer.json"));
      assert.deepEqual(devcontainer.build, { dockerfile: "../Dockerfile", context: "..", args: { SCANTOR_BASE: data.BaseImage } });
      assert.equal(devcontainer.workspaceFolder, "/task");
      const languages = readJson<Record<string, any>>("languages.json");
      assert.deepEqual(
        new Set(devcontainer.customizations.vscode.extensions),
        new Set([...languages.languages[spec.language].editorExtensions, ...languages.commonEditorExtensions]),
      );
      assert.deepEqual(devcontainer.customizations.vscode.settings["yaml.schemas"], { [data.ManifestSchemaURL]: "scantor.yaml" });

      const launch = readJsonFile(join(folder, ".vscode/launch.json")).configurations[0];
      assert.deepEqual([launch.type, launch.request, launch.port, launch.localRoot, launch.remoteRoot], [
        "node",
        "attach",
        9229,
        "${workspaceFolder}",
        "/task",
      ]);
      const tasks = readJsonFile(join(folder, ".vscode/tasks.json")).tasks as { label: string }[];
      assert.deepEqual(tasks.map((task) => task.label), ["scantor: validate", "scantor: dev run", "scantor: dev debug", "scantor: push"]);
      const settings = readJsonFile(join(folder, ".vscode/settings.json"));
      assert.deepEqual(settings, { "yaml.schemas": { [data.ManifestSchemaURL]: "scantor.yaml" }, "files.exclude": { ".scantor": true } });

      const agents = readFileSync(join(folder, "AGENTS.md"), "utf8");
      assert.ok(agents.startsWith(`# ${data.Name} — a scantor task (${spec.language})\n`));
      assert.ok(agents.includes(`Guide: ${data.GuideURL}\n`));
    });

    for (const template of ENTRIES) {
      test(`entry ${template} type-checks, describes and runs`, { skip: NEEDS_INSTALLED_CONNECTOR }, async () => {
        const folder = scaffold(spec, template);
        const entry = `main.${spec.extension}`;
        assert.deepEqual(Object.values(typeCheck(folder, entry)), [0, ""]);

        const runtime = await FakeRuntime.ready(entry, {}, { cwd: folder, installed: true });
        runtimes.push(runtime);
        runtime.send({ type: "describe", id: "d1" });
        const description = await runtime.reply("d1");
        const expected = template === "custom" ? { kind: "custom" } : { kind: "template", template };
        assert.deepEqual(description.schedule, expected);
        assert.deepEqual(description.warnings, []);
        assert.equal(description.schemas.taskConfig.properties.greeting.default, "Hello");

        let analysisConfig: Message = {};
        if (template === "custom") {
          const { configs, end } = await runtime.collect(runtime.schedule({}));
          assert.deepEqual(configs, [{ n: 0 }, { n: 1 }, { n: 2 }]);
          assert.equal(end.type, "done");
          analysisConfig = configs[0]!;
        } else if (template !== "single") {
          const fixtures = readJson<Record<string, any>>(`templates/${template}.fixtures.json`);
          analysisConfig = fixtures.analysisConfig.valid[0].input;
        }
        const reply = await runtime.reply(runtime.run(analysisConfig));
        assert.equal(reply.type, "result", JSON.stringify(reply));
        assert.match(reply.result.text, /^Hello, /);
      });
    }
  });
}
