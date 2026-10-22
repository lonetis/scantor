// Template cidr (schemas/templates/cidr.json): one analysis per address, or per subnet, of IP ranges.
import { config, z } from "../schema.ts";
import { defineTemplate } from "./proxy.ts";

const range = z.string().min(2).max(49);

export const ScanConfig = config({
  cidrs: z
    .array(range)
    .min(1)
    .max(1000)
    .default(["192.0.2.0/29"])
    .describe("CIDR ranges or single addresses (IPv4 or IPv6). Host bits are cleared."),
  exclude: z
    .array(range)
    .max(1000)
    .default([])
    .describe("CIDR ranges or addresses never to emit (in subnet mode: subnets that intersect an exclusion are skipped)."),
  prefix: z
    .number()
    .int()
    .min(0)
    .max(128)
    .nullable()
    .default(null)
    .describe(
      "null = one analysis per address; otherwise one analysis per subnet of this length (each cidr must be at least that large; ≤ 32 when any IPv4 range is present).",
    ),
  maxAnalyses: z
    .number()
    .int()
    .min(1)
    .max(100000000)
    .default(65536)
    .describe("Required safety cap: the scan is rejected when the expansion is larger."),
});
export type ScanConfig = z.output<typeof ScanConfig>;

export const AnalysisConfig = config({
  ip: z.string().min(2).max(39).describe("Address, or network address of the subnet (RFC 5952 text form for IPv6)."),
  prefix: z.number().int().min(0).max(128).describe("32/128 for single addresses, otherwise the subnet length."),
  version: z.literal([4, 6]).describe("IP version."),
});
export type AnalysisConfig = z.output<typeof AnalysisConfig>;

export const schedule = defineTemplate("cidr", ScanConfig, AnalysisConfig);
