// Task folders outside this package: the examples (tasks/) and rendered scaffolds (scaffolds/).
import { spawnSync } from "node:child_process";
import { INSTALLED_CONNECTOR } from "./runtime.ts";

/** Runs SCANTOR_CHECK_CMD of the base image in `folder`. */
export function typeCheck(folder: string, entry: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [`${INSTALLED_CONNECTOR}/check.js`, entry], { cwd: folder, encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr };
}

export interface RenderData {
  Name: string;
  Description: string;
  Language: string;
  Template: string;
  Version: string;
  BaseImage: string;
  ManifestSchemaURL: string;
  GuideURL: string;
}

/**
 * Enough of Go text/template with `[[ ]]` delimiters for the scaffolds: `[[.Field]]`,
 * `[[printf "%q" .Field]]` (JSON quoting, identical for the test data), `[[if .Field]]…[[end]]` and the
 * `[[-` trim marker.
 */
export function render(text: string, data: RenderData): string {
  const value = (field: string): string => {
    if (!Object.hasOwn(data, field)) throw new Error(`unknown template field ${field}`);
    return data[field as keyof RenderData];
  };
  const rendered = text
    .replace(/\s*\[\[- /g, "[[")
    .replace(/\[\[if \.(\w+)\]\]([\s\S]*?)\[\[end\]\]/g, (_match, field: string, body: string) => (value(field) ? body : ""))
    .replace(/\[\[printf "%q" \.(\w+)\]\]/g, (_match, field: string) => JSON.stringify(value(field)))
    .replace(/\[\[\.(\w+)\]\]/g, (_match, field: string) => value(field));
  if (rendered.includes("[[")) throw new Error(`unrendered action in:\n${rendered}`);
  return rendered;
}
