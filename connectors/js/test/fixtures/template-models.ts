// The conformance `template-models` fixture: parses configs with the native models of any template.
import { config, defineTask, z } from "@scantor/connector";
import * as templates from "@scantor/connector/templates";

type Name = Exclude<keyof typeof templates, never>;

function template(name: string): (typeof templates)[Name] {
  if (!Object.hasOwn(templates, name)) throw new Error(`unknown template ${name}`);
  return templates[name as Name];
}

export default defineTask({
  scanConfig: config({ template: z.string(), config: z.record(z.string(), z.unknown()) }),
  analysisConfig: config({ template: z.string(), config: z.record(z.string(), z.unknown()) }),
  result: z.object({ config: z.record(z.string(), z.unknown()) }),
  async *schedule(ctx, scanConfig) {
    const proxy = template(scanConfig.template);
    const native = proxy.ScanConfig.parse(scanConfig.config);
    for await (const item of (proxy.schedule as (ctx: unknown, sc: unknown) => AsyncIterable<Record<string, unknown>>)(ctx, native)) {
      yield { template: scanConfig.template, config: item };
    }
  },
  run: (ctx, analysisConfig) => ({ config: template(analysisConfig.template).AnalysisConfig.parse(analysisConfig.config) }),
});
