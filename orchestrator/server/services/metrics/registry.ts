// A small Prometheus metrics registry with the text exposition format 0.0.4 (docs/deployment.md §13.1): counters,
// gauges and histograms with fixed label names. In-process only; /api/metrics renders it.

export type Labels = Record<string, string>

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Number.POSITIVE_INFINITY) return '+Inf'
  if (value === Number.NEGATIVE_INFINITY) return '-Inf'
  return String(value)
}

function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')
}

function escapeHelp(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('\n', '\\n')
}

function renderLabels(names: readonly string[], values: readonly string[], extra?: [string, string]): string {
  const pairs = names.map((name, index) => `${name}="${escapeLabelValue(values[index]!)}"`)
  if (extra) pairs.push(`${extra[0]}="${escapeLabelValue(extra[1])}"`)
  return pairs.length > 0 ? `{${pairs.join(',')}}` : ''
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
  ) {}

  abstract readonly type: 'counter' | 'gauge' | 'histogram'

  protected key(labels: Labels | undefined): string[] {
    const provided = labels ?? {}
    for (const name of Object.keys(provided)) {
      if (!this.labelNames.includes(name)) throw new Error(`metric ${this.name} has no label ${name}`)
    }
    return this.labelNames.map((name) => {
      const value = provided[name]
      if (value === undefined) throw new Error(`metric ${this.name} needs label ${name}`)
      return value
    })
  }

  protected header(): string[] {
    return [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${this.type}`]
  }

  abstract render(): string[]
}

class Sampled extends Metric {
  readonly type: 'counter' | 'gauge' = 'gauge'
  protected readonly samples = new Map<string, { labels: string[]; value: number }>()

  protected update(labels: Labels | undefined, fn: (current: number) => number): void {
    const values = this.key(labels)
    const id = JSON.stringify(values)
    const sample = this.samples.get(id)
    if (sample) sample.value = fn(sample.value)
    else this.samples.set(id, { labels: values, value: fn(0) })
  }

  /** The current value of one label combination (0 when never set). */
  get(labels?: Labels): number {
    return this.samples.get(JSON.stringify(this.key(labels)))?.value ?? 0
  }

  render(): string[] {
    const lines = this.header()
    for (const sample of this.samples.values()) {
      lines.push(`${this.name}${renderLabels(this.labelNames, sample.labels)} ${formatNumber(sample.value)}`)
    }
    return lines
  }
}

export class Counter extends Sampled {
  override readonly type = 'counter' as const

  inc(labels?: Labels, value = 1): void {
    if (value < 0) throw new Error(`counter ${this.name} cannot decrease`)
    this.update(labels, (current) => current + value)
  }
}

export class Gauge extends Sampled {
  override readonly type = 'gauge' as const

  set(labels: Labels | undefined, value: number): void {
    this.update(labels, () => value)
  }

  inc(labels?: Labels, value = 1): void {
    this.update(labels, (current) => current + value)
  }

  dec(labels?: Labels, value = 1): void {
    this.update(labels, (current) => current - value)
  }

  /** Replaces every sample at once (scrape-time collection, so vanished label combinations disappear). */
  replace(samples: readonly [Labels | undefined, number][]): void {
    this.samples.clear()
    for (const [labels, value] of samples) this.set(labels, value)
  }
}

export const DEFAULT_SECONDS_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120]

export class Histogram extends Metric {
  readonly type = 'histogram' as const
  private readonly series = new Map<string, { labels: string[]; counts: number[]; sum: number; count: number }>()

  constructor(name: string, help: string, labelNames: readonly string[], readonly buckets: readonly number[] = DEFAULT_SECONDS_BUCKETS) {
    super(name, help, labelNames)
    if (buckets.some((bucket, index) => index > 0 && bucket <= buckets[index - 1]!)) {
      throw new Error(`histogram ${name} buckets must increase`)
    }
  }

  observe(labels: Labels | undefined, value: number): void {
    const values = this.key(labels)
    const id = JSON.stringify(values)
    let entry = this.series.get(id)
    if (!entry) {
      entry = { labels: values, counts: this.buckets.map(() => 0), sum: 0, count: 0 }
      this.series.set(id, entry)
    }
    for (const [index, bound] of this.buckets.entries()) if (value <= bound) entry.counts[index]! += 1
    entry.sum += value
    entry.count += 1
  }

  render(): string[] {
    const lines = this.header()
    for (const entry of this.series.values()) {
      for (const [index, bound] of this.buckets.entries()) {
        lines.push(`${this.name}_bucket${renderLabels(this.labelNames, entry.labels, ['le', formatNumber(bound)])} ${entry.counts[index]}`)
      }
      lines.push(`${this.name}_bucket${renderLabels(this.labelNames, entry.labels, ['le', '+Inf'])} ${entry.count}`)
      lines.push(`${this.name}_sum${renderLabels(this.labelNames, entry.labels)} ${formatNumber(entry.sum)}`)
      lines.push(`${this.name}_count${renderLabels(this.labelNames, entry.labels)} ${entry.count}`)
    }
    return lines
  }
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>()

  private add<T extends Metric>(metric: T): T {
    if (this.metrics.has(metric.name)) throw new Error(`metric ${metric.name} is registered twice`)
    this.metrics.set(metric.name, metric)
    return metric
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.add(new Counter(name, help, labelNames))
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.add(new Gauge(name, help, labelNames))
  }

  histogram(name: string, help: string, labelNames: readonly string[] = [], buckets?: readonly number[]): Histogram {
    return this.add(new Histogram(name, help, labelNames, buckets))
  }

  /** Every registered metric with its type and label names (catalogue drift tests). */
  describe(): { name: string; type: string; labelNames: readonly string[] }[] {
    return [...this.metrics.values()].map((metric) => ({ name: metric.name, type: metric.type, labelNames: metric.labelNames }))
  }

  /** The Prometheus text exposition (version 0.0.4) of every metric. */
  render(): string {
    const lines: string[] = []
    for (const metric of this.metrics.values()) lines.push(...metric.render())
    return `${lines.join('\n')}\n`
  }
}
