// Template list (schemas/templates/list.json): one analysis per inline item and uploaded line.
import { config, z } from "../schema.ts";
import { defineTemplate } from "./proxy.ts";

export const ScanConfig = config({
  items: z.array(z.string().min(1).max(4096)).max(10000).default([]).describe("Inline items (trimmed; empty items skipped)."),
  upload: z
    .guid()
    .nullable()
    .default(null)
    .meta({
      "x-scantor": "upload",
      description: "Id of an uploaded list (POST /api/uploads, kind list); its non-empty lines follow the inline items.",
    }),
  offset: z.number().int().min(0).default(0).describe("Skip this many items of the combined sequence."),
  limit: z.number().int().min(1).nullable().default(null).describe("At most this many analyses; null = all."),
});
export type ScanConfig = z.output<typeof ScanConfig>;

export const AnalysisConfig = config({
  item: z.string().min(1).max(4096).describe("The trimmed item."),
  index: z
    .number()
    .int()
    .min(0)
    .describe("0-based position in the combined sequence (inline items, then upload lines), before offset."),
});
export type AnalysisConfig = z.output<typeof AnalysisConfig>;

export const schedule = defineTemplate("list", ScanConfig, AnalysisConfig);
