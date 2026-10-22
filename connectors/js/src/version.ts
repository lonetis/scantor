import { readFileSync } from "node:fs";

/**
 * The connector version reported in `hello`: `scantorVersion` in package.json, which the base image build
 * sets to the scantor version (VERSION build argument); "dev" in a source checkout.
 */
function readVersion(): string {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scantorVersion?: unknown;
  };
  return typeof packageJson.scantorVersion === "string" && packageJson.scantorVersion.length > 0
    ? packageJson.scantorVersion
    : "dev";
}

export const connectorVersion: string = readVersion();
