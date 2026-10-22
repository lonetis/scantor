// SCANTOR_CONNECTOR_CMD: `node /node_modules/@scantor/connector/serve.js {entry}` calls main().
import { extname } from "node:path";
import { isProtocolFd } from "./channel.ts";
import { Connector, type Language } from "./connector.ts";
import { connectorVersion } from "./version.ts";

const NOT_A_PROGRAM = 'scantor: this program is a scantor task connector; run it with "scantor dev run"\n';

function protocolFd(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** The JS connector serves both languages and decides by the entry's extension (docs/protocol.md §5.2). */
function languageOf(entry: string): Language {
  return [".ts", ".mts", ".cts"].includes(extname(entry)) ? "typescript" : "javascript";
}

export function main(): void {
  const inFd = protocolFd("SCANTOR_PROTOCOL_IN_FD", 3);
  const outFd = protocolFd("SCANTOR_PROTOCOL_OUT_FD", 4);
  if (!isProtocolFd(inFd, "read") || !isProtocolFd(outFd, "write")) {
    process.stderr.write(NOT_A_PROGRAM);
    process.exit(2);
  }
  const entry = process.argv[2];
  if (entry === undefined || entry.length === 0) {
    process.stderr.write("scantor connector: usage: serve.js <entry>\n");
    process.exit(2);
  }
  new Connector({ entry, language: languageOf(entry), version: connectorVersion, inFd, outFd }).start();
}
