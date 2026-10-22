// Loads the canonical schemas of the repository (schemas/) for validating what the connector writes.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ValidateFunction } from "ajv";
import ajv2020 from "ajv/dist/2020.js";

// ajv ships CommonJS: the module object is the default import and the class its `default` property.
const Ajv2020 = ajv2020.default;

export const schemasDir = fileURLToPath(new URL("../../../../schemas/", import.meta.url));

export function readJson<T = unknown>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, `file://${schemasDir}`), "utf8")) as T;
}

function protocolAjv(): InstanceType<typeof Ajv2020> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addKeyword("x-scantor");
  for (const file of readdirSync(`${schemasDir}protocol`)) {
    if (file.endsWith(".schema.json")) ajv.addSchema(readJson(`protocol/${file}`));
  }
  return ajv;
}

const ajv = protocolAjv();
const MESSAGE = "https://scantor.dev/schemas/protocol/message.schema.json";

export const validateConnectorLine: ValidateFunction = ajv.compile({ $ref: `${MESSAGE}#/$defs/connectorToRuntime` });

export function validatorFor(type: string): ValidateFunction {
  const validate = ajv.getSchema(`https://scantor.dev/schemas/protocol/${type}.schema.json`);
  if (validate === undefined) throw new Error(`no protocol schema for ${type}`);
  return validate;
}

export interface TemplateFixtures {
  template: string;
  scanConfig: {
    valid: { name: string; input: Record<string, unknown>; effective: Record<string, unknown> }[];
    invalid: { name: string; input: Record<string, unknown>; kind: "schema" | "semantic"; path: string }[];
  };
  analysisConfig: {
    valid: { name: string; input: Record<string, unknown> }[];
    invalid: { name: string; input: Record<string, unknown>; path: string }[];
  };
}

export const TEMPLATE_NAMES = readdirSync(`${schemasDir}templates`)
  .filter((file) => file.endsWith(".json") && !file.endsWith(".fixtures.json"))
  .map((file) => file.slice(0, -".json".length))
  .sort();

/** The repository root (the test stage of connectors/js/Dockerfile keeps the layout under /repo). */
export const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** Validates a parsed scantor.yaml against schemas/task-manifest.schema.json. */
export const validateManifest: ValidateFunction = new Ajv2020({ allErrors: true, strict: false }).compile(
  readJson("task-manifest.schema.json"),
);
