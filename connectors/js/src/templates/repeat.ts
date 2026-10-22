// Template repeat (schemas/templates/repeat.json): `times` analyses numbered by iteration.
import { config, z } from "../schema.ts";
import { defineTemplate } from "./proxy.ts";

export const ScanConfig = config({
  times: z.number().int().min(1).default(1).describe("Number of analyses."),
});
export type ScanConfig = z.output<typeof ScanConfig>;

export const AnalysisConfig = config({
  iteration: z.number().int().min(0).describe("0-based iteration."),
});
export type AnalysisConfig = z.output<typeof AnalysisConfig>;

export const schedule = defineTemplate("repeat", ScanConfig, AnalysisConfig);
