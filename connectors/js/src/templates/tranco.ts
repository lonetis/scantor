// Template tranco (schemas/templates/tranco.json): domains of a Tranco top list with their exact rank.
import { config, z } from "../schema.ts";
import { defineTemplate } from "./proxy.ts";

export const ScanConfig = config({
  list: z
    .string()
    .regex(/^(latest|[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9A-Z]{4,6})$/)
    .default("latest")
    .describe("`latest`, a date YYYY-MM-DD (the daily list of that date) or a Tranco list id."),
  subdomains: z
    .boolean()
    .default(false)
    .describe("Use the daily list that includes subdomains (only for `latest` and dates)."),
  offset: z.number().int().min(0).max(999999).default(0).describe("Skip this many top entries (offset + limit ≤ 1000000)."),
  limit: z.number().int().min(1).max(1000000).default(1000).describe("Number of domains."),
});
export type ScanConfig = z.output<typeof ScanConfig>;

export const AnalysisConfig = config({
  domain: z.string().min(1).max(253).describe("Registrable domain as listed (no scheme, no www.)."),
  rank: z.number().int().min(1).max(1000000).describe("1-based Tranco rank."),
});
export type AnalysisConfig = z.output<typeof AnalysisConfig>;

export const schedule = defineTemplate("tranco", ScanConfig, AnalysisConfig);
