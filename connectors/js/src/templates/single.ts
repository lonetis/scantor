// Template single (schemas/templates/single.json): exactly one analysis with an empty analysis config.
import { Empty, type z } from "../schema.ts";
import { defineTemplate } from "./proxy.ts";

export const ScanConfig = Empty;
export type ScanConfig = z.output<typeof ScanConfig>;

export const AnalysisConfig = Empty;
export type AnalysisConfig = z.output<typeof AnalysisConfig>;

export const schedule = defineTemplate("single", ScanConfig, AnalysisConfig);
