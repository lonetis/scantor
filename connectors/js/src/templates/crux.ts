// Template crux (schemas/templates/crux.json): origins of a CrUX list (crux-top-lists or crux-cache) up to a rank bucket.
import { config, z } from "../schema.ts";
import { defineTemplate } from "./proxy.ts";

const BUCKETS = [1000, 5000, 10000, 50000, 100000, 500000, 1000000, 5000000, 10000000, 50000000] as const;

export const ScanConfig = config({
  source: z
    .enum(["crux-top-lists", "crux-cache"])
    .default("crux-top-lists")
    .describe(
      "Where the list comes from: `crux-top-lists` (zakird/crux-top-lists: rank buckets up to 1000000, country lists from 202501) or `crux-cache` (lonetis/crux-cache: every origin and bucket, the countries it publishes).",
    ),
  country: z
    .string()
    .regex(/^(global|[a-z]{2})$/)
    .default("global")
    .describe(
      "`global` or a lowercase ISO 3166-1 alpha-2 country code (crux-top-lists has country lists from 202501, crux-cache only the countries it publishes).",
    ),
  month: z
    .string()
    .regex(/^(latest|[0-9]{4}(0[1-9]|1[0-2]))$/)
    .default("latest")
    .describe("`latest` or a month YYYYMM."),
  bucket: z
    .literal(BUCKETS)
    .default(1000)
    .describe("Include origins with rank bucket ≤ this value (the cap of the scan); buckets above 1000000 need source crux-cache."),
});
export type ScanConfig = z.output<typeof ScanConfig>;

export const AnalysisConfig = config({
  origin: z
    .string()
    .min(1)
    .max(2048)
    .describe("Origin as listed (scheme + host, no trailing slash; http and https occur)."),
  rank: z.literal(BUCKETS).describe("CrUX rank bucket of the origin."),
});
export type AnalysisConfig = z.output<typeof AnalysisConfig>;

export const schedule = defineTemplate("crux", ScanConfig, AnalysisConfig);
