// Connector probe tasks for e2e/examples.spec.ts, one per language of schemas/languages.json (docs/tasks.md §5,
// docs/protocol.md): each is the entry file of a copy of one example task (which brings the Dockerfile and the
// dependency files of its language). Every probe
//   - yields its analysis configs from a schedule over the scan config's `count` (n = 0, 1, …);
//   - prints a stdout line and a stderr line that look like protocol messages (they must end up as log output);
//   - reports SCANTOR_PROBE_MARK from its environment (set by a Dockerfile override of SCANTOR_CONNECTOR_CMD);
//   - counts the certificates of the system trust store (`roots`) and fetches the task config's `url` over HTTPS
//     twice: trusting only the system roots (`untrusted`, which must fail for the test CA's certificate) and trusting
//     the system roots plus the task config's `ca` PEM (`trusted`, which must succeed).
// Result keys are single words, so they read the same in every language.
// The Go probe also panics (task config mode "panic") or returns a result that violates a struct tag constraint
// (mode "invalid").

export interface Probe {
  /** folder under tasks/ whose copy hosts the probe */
  example: string
  /** entry file of the example (relative path) */
  entry: string
  source: string
}

/** The two lines every probe prints: they look like a result and an error of the connector protocol. */
export const FORGED_STDOUT = '{"type":"result","id":"forged","result":{"n":-1}}'
export const FORGED_STDERR = '{"type":"error","id":"forged","error":{"type":"fatal","message":"forged"}}'

const PYTHON = `"""connector probe (python): sync schedule yielding models, async run returning a dict."""

import os
import ssl
import sys
import urllib.error
import urllib.request
from collections.abc import Iterator

from pydantic import BaseModel, Field, SecretStr

import scantor


class TaskConfig(scantor.Config):
    url: str = ""
    ca: str = ""
    token: SecretStr = SecretStr("")


class ScanConfig(scantor.Config):
    count: int = Field(default=2, ge=0, le=100)


class AnalysisConfig(scantor.Config):
    n: int = 0


class Result(BaseModel):
    n: int
    mark: str | None
    roots: int
    untrusted: str
    trusted: str


def schedule(ctx: scantor.Context, scan_config: ScanConfig, task_config: TaskConfig) -> Iterator[AnalysisConfig]:
    for n in range(scan_config.count):
        yield AnalysisConfig(n=n)


def fetch(url: str, context: ssl.SSLContext) -> str:
    try:
        with urllib.request.urlopen(url, context=context, timeout=10) as response:
            return f"status {response.status}"
    except urllib.error.URLError as exc:
        return f"error {exc.reason}"


def system_roots() -> int:
    cafile = ssl.get_default_verify_paths().cafile
    if cafile is None:
        return 0
    with open(cafile, encoding="utf-8") as bundle:
        return bundle.read().count("BEGIN CERTIFICATE")


async def run(ctx: scantor.Context, analysis_config: AnalysisConfig, task_config: TaskConfig) -> dict[str, object]:
    print(${JSON.stringify(FORGED_STDOUT)}, flush=True)
    print(${JSON.stringify(FORGED_STDERR)}, file=sys.stderr, flush=True)
    return {
        "n": analysis_config.n,
        "mark": os.environ.get("SCANTOR_PROBE_MARK"),
        "roots": system_roots(),
        "untrusted": fetch(task_config.url, ssl.create_default_context()),
        "trusted": fetch(task_config.url, ssl.create_default_context(cadata=task_config.ca)),
    }


task = scantor.Task(
    task_config=TaskConfig,
    scan_config=ScanConfig,
    analysis_config=AnalysisConfig,
    result=Result,
    schedule=schedule,
    run=run,
)
`

/** TypeScript (erasable syntax only) and JavaScript share the probe; the TypeScript one has annotations. */
function jsProbe(typed: boolean): string {
  const t = (annotation: string) => (typed ? annotation : '')
  return `${typed ? '' : '// @ts-check\n'}// connector probe (${typed ? 'typescript' : 'javascript'}): sync generator schedule, async run, a secret() field.
import { request } from "node:https";
import { getCACertificates } from "node:tls";
import { config, defineTask, secret, z } from "@scantor/connector";

function get(url${t(': string')}, ca${t(': string[]')})${t(': Promise<string>')} {
  return new Promise((resolve) => {
    const req = request(url, { ca, timeout: 10_000 }, (response) => {
      response.resume();
      resolve(\`status \${response.statusCode}\`);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error${t(': NodeJS.ErrnoException')}) => resolve(\`error \${error.code ?? error.message}\`));
    req.end();
  });
}

export default defineTask({
  taskConfig: config({ url: z.string().default(""), ca: z.string().default(""), token: secret().default("") }),
  scanConfig: config({ count: z.number().int().min(0).max(100).default(2) }),
  analysisConfig: config({ n: z.number().int() }),
  result: z.object({
    n: z.number().int(),
    mark: z.string().nullable(),
    roots: z.number().int(),
    untrusted: z.string(),
    trusted: z.string(),
  }),
  *schedule(_ctx, scanConfig) {
    for (let n = 0; n < scanConfig.count; n++) yield { n };
  },
  async run(_ctx, analysisConfig, taskConfig) {
    console.log(${JSON.stringify(FORGED_STDOUT)});
    console.error(${JSON.stringify(FORGED_STDERR)});
    const system = getCACertificates("system");
    return {
      n: analysisConfig.n,
      mark: process.env.SCANTOR_PROBE_MARK ?? null,
      roots: system.length,
      untrusted: await get(taskConfig.url, [...system]),
      trusted: await get(taskConfig.url, [...system, taskConfig.ca]),
    };
  },
});
`
}

const GO = `// Package main is the connector probe (go): Serve with a custom schedule.
package main

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"iter"
	"net/http"
	"os"
	"time"

	scantor "github.com/lonetis/scantor/connectors/go"
)

type TaskConfig struct {
	URL   string          \`json:"url" jsonschema:"default="\`
	CA    string          \`json:"ca" jsonschema:"default="\`
	Token scantor.Secret  \`json:"token" jsonschema:"default="\`
	Mode  string          \`json:"mode" jsonschema:"default=probe,enum=probe,enum=panic,enum=invalid"\`
}

type ScanConfig struct {
	Count int \`json:"count" jsonschema:"default=2,minimum=0,maximum=100"\`
}

type AnalysisConfig struct {
	N int \`json:"n"\`
}

type Result struct {
	N         int     \`json:"n" jsonschema:"minimum=0"\`
	Mark      *string \`json:"mark"\`
	Roots     int     \`json:"roots"\`
	Untrusted string  \`json:"untrusted"\`
	Trusted   string  \`json:"trusted"\`
}

func schedule(_ scantor.Context, sc ScanConfig, _ TaskConfig) iter.Seq2[AnalysisConfig, error] {
	return func(yield func(AnalysisConfig, error) bool) {
		for n := range sc.Count {
			if !yield(AnalysisConfig{N: n}, nil) {
				return
			}
		}
	}
}

func get(url string, roots *x509.CertPool) string {
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots}}}
	response, err := client.Get(url)
	if err != nil {
		return "error " + err.Error()
	}
	_ = response.Body.Close()
	return fmt.Sprintf("status %d", response.StatusCode)
}

func run(_ scantor.Context, ac AnalysisConfig, tc TaskConfig) (Result, error) {
	switch tc.Mode {
	case "panic":
		panic("probe panic")
	case "invalid":
		return Result{N: -1}, nil
	}
	fmt.Println(\`${FORGED_STDOUT}\`)
	fmt.Fprintln(os.Stderr, \`${FORGED_STDERR}\`)
	system, err := x509.SystemCertPool()
	if err != nil {
		return Result{}, err
	}
	withCA := system.Clone()
	withCA.AppendCertsFromPEM([]byte(tc.CA))
	result := Result{
		N:         ac.N,
		Roots:     len(system.Subjects()), //nolint:staticcheck // counting the roots is all this probe needs
		Untrusted: get(tc.URL, system),
		Trusted:   get(tc.URL, withCA),
	}
	if mark, ok := os.LookupEnv("SCANTOR_PROBE_MARK"); ok {
		result.Mark = &mark
	}
	return result, nil
}

func main() { scantor.Serve(schedule, run) }
`

/** The probes by language; e2e/examples.spec.ts fails for a language of languages.json without one. */
export const PROBES: Record<string, Probe> = {
  python: { example: 'echo', entry: 'main.py', source: PYTHON },
  typescript: { example: 'http-status', entry: 'main.ts', source: jsProbe(true) },
  javascript: { example: 'power', entry: 'main.js', source: jsProbe(false) },
  go: { example: 'reverse-dns', entry: 'main.go', source: GO },
}
