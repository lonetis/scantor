// Template range (schemas/templates/range.json): start, start + step, … up to but excluding end.
import { config, z } from "../schema.ts";
import { defineTemplate } from "./proxy.ts";

export const ScanConfig = config({
  start: z.number().int().default(0).describe("First value (inclusive)."),
  end: z.number().int().default(10).describe("Bound (exclusive)."),
  step: z.number().int().default(1).describe("Increment; negative counts down; 0 is rejected."),
});
export type ScanConfig = z.output<typeof ScanConfig>;

export const AnalysisConfig = config({
  value: z.number().int().describe("The integer."),
});
export type AnalysisConfig = z.output<typeof AnalysisConfig>;

export const schedule = defineTemplate("range", ScanConfig, AnalysisConfig);
