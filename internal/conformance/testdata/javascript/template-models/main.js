// The conformance `template-models` fixture: configs parsed with the native models of any template.
import { config, defineTask, z } from "@scantor/connector";
import * as templates from "@scantor/connector/templates";


function template(name) {
  if (!Object.hasOwn(templates, name)) throw new Error(`unknown template ${name}`);
  return templates[name];
}

export default defineTask({
  scanConfig: config({ template: z.string(), config: z.record(z.string(), z.unknown()) }),
  analysisConfig: config({ template: z.string(), config: z.record(z.string(), z.unknown()) }),
  result: z.object({ config: z.record(z.string(), z.unknown()) }),
  async *schedule(ctx, scanConfig) {
    const proxy = template(scanConfig.template);
    const native = proxy.ScanConfig.parse(scanConfig.config);
    const stream = proxy.schedule(ctx, native);
    for await (const item of stream) {
      yield { template: scanConfig.template, config: item };
    }
  },
  run: (ctx, analysisConfig) => ({ config: template(analysisConfig.template).AnalysisConfig.parse(analysisConfig.config) }),
});
