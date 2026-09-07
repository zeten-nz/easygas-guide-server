/**
 * Phase 10F — production-safe metrics (dependency-free Prometheus text exposition).
 *
 * A tiny in-house registry is used instead of pulling in a monitoring stack: it
 * keeps the dependency/audit surface at zero, gives full control over label
 * CARDINALITY (the main production risk), and emits the standard Prometheus text
 * format so any Prometheus-compatible scraper can read it.
 *
 * Cardinality rules enforced here:
 *  - labels are only ever LOW-CARDINALITY dimensions (method, route TEMPLATE,
 *    status class 2xx/4xx/…, limiter name, outcome, check name, pool state);
 *  - NEVER a job id, user id, phone, raw route parameter, digest or coordinate.
 *  - label values are length-capped as a backstop.
 *
 * The endpoint that exposes this is access-controlled in app.ts (token-gated,
 * never public in production).
 */

type Labels = Record<string, string>;

const MAX_LABEL_LEN = 64;

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"').slice(0, MAX_LABEL_LEN);
}

/** Deterministic key + rendered label set for a metric sample. */
function renderLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return '{' + keys.map((k) => `${k}="${escapeLabelValue(String(labels[k]))}"`).join(',') + '}';
}

interface Sample {
  labels: Labels;
  value: number;
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: 'counter' | 'gauge' | 'histogram',
  ) {}
  abstract collect(): string[];
  protected header(): string[] {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];
  }
}

export class Counter extends Metric {
  private store = new Map<string, Sample>();
  constructor(name: string, help: string, readonly labelNames: string[] = []) {
    super(name, help, 'counter');
  }
  inc(labels: Labels = {}, value = 1): void {
    const key = renderLabels(labels);
    const cur = this.store.get(key);
    if (cur) cur.value += value;
    else this.store.set(key, { labels, value });
  }
  collect(): string[] {
    const lines = this.header();
    if (this.store.size === 0) lines.push(`${this.name} 0`);
    for (const s of this.store.values()) lines.push(`${this.name}${renderLabels(s.labels)} ${s.value}`);
    return lines;
  }
}

export class Gauge extends Metric {
  private store = new Map<string, Sample>();
  constructor(name: string, help: string, readonly labelNames: string[] = []) {
    super(name, help, 'gauge');
  }
  set(labels: Labels, value: number): void;
  set(value: number): void;
  set(a: Labels | number, b?: number): void {
    const labels = typeof a === 'number' ? {} : a;
    const value = typeof a === 'number' ? a : (b as number);
    this.store.set(renderLabels(labels), { labels, value });
  }
  collect(): string[] {
    const lines = this.header();
    if (this.store.size === 0) lines.push(`${this.name} 0`);
    for (const s of this.store.values()) lines.push(`${this.name}${renderLabels(s.labels)} ${s.value}`);
    return lines;
  }
}

export class Histogram extends Metric {
  private buckets: number[];
  private counts = new Map<string, { labels: Labels; bucketCounts: number[]; sum: number; count: number }>();
  constructor(name: string, help: string, opts: { labelNames?: string[]; buckets?: number[] } = {}) {
    super(name, help, 'histogram');
    this.buckets = (opts.buckets ?? [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]).slice().sort((a, b) => a - b);
    this.labelNames = opts.labelNames ?? [];
  }
  readonly labelNames: string[];
  observe(labels: Labels, value: number): void {
    const key = renderLabels(labels);
    let e = this.counts.get(key);
    if (!e) {
      e = { labels, bucketCounts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.counts.set(key, e);
    }
    e.sum += value;
    e.count += 1;
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]) e.bucketCounts[i] += 1;
  }
  collect(): string[] {
    const lines = this.header();
    for (const e of this.counts.values()) {
      const base = renderLabels(e.labels);
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative = e.bucketCounts[i];
        const le = String(this.buckets[i]);
        lines.push(`${this.name}_bucket${withLe(base, le)} ${cumulative}`);
      }
      lines.push(`${this.name}_bucket${withLe(base, '+Inf')} ${e.count}`);
      lines.push(`${this.name}_sum${base} ${e.sum}`);
      lines.push(`${this.name}_count${base} ${e.count}`);
    }
    return lines;
  }
}

function withLe(base: string, le: string): string {
  if (base === '') return `{le="${le}"}`;
  return base.slice(0, -1) + `,le="${le}"}`;
}

type Collector = () => void;

class Registry {
  private metrics: Metric[] = [];
  private collectors: Collector[] = [];
  register<T extends Metric>(m: T): T {
    this.metrics.push(m);
    return m;
  }
  /** A function run at scrape time to refresh pull-style gauges (pool, memory…). */
  addCollector(fn: Collector): void {
    this.collectors.push(fn);
  }
  async expose(): Promise<string> {
    for (const c of this.collectors) {
      try {
        c();
      } catch {
        /* a failing collector must never break the scrape */
      }
    }
    return this.metrics.map((m) => m.collect().join('\n')).join('\n\n') + '\n';
  }
  /** Test helper — reset counters/gauges between cases (never used in prod paths). */
  clearForTests(): void {
    this.metrics = [];
    this.collectors = [];
  }
}

export const registry = new Registry();

// ---------------------------------------------------------------------------
// Metric definitions (low-cardinality labels only)
// ---------------------------------------------------------------------------
export const httpRequestsTotal = registry.register(
  new Counter('easygas_http_requests_total', 'HTTP requests by method, route template and status class', ['method', 'route', 'status_class']),
);
export const httpRequestDuration = registry.register(
  new Histogram('easygas_http_request_duration_seconds', 'HTTP request duration in seconds', {
    labelNames: ['method', 'route', 'status_class'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  }),
);
export const rateLimitRejectionsTotal = registry.register(
  new Counter('easygas_rate_limit_rejections_total', 'Rate-limit rejections by limiter name and mode', ['limiter', 'mode']),
);
export const smsWorkerOutcomesTotal = registry.register(
  new Counter('easygas_sms_worker_outcomes_total', 'SMS worker delivery outcomes by result', ['outcome']),
);
export const storageFailuresTotal = registry.register(
  new Counter('easygas_storage_failures_total', 'Object-storage operation failures by operation', ['op']),
);
export const auditVerificationFailuresTotal = registry.register(
  new Counter('easygas_audit_verification_failures_total', 'Audit-chain verification failures observed by the process', []),
);

// Pull-style gauges (refreshed by collectors registered from wiring code).
export const dbPoolConnections = registry.register(new Gauge('easygas_db_pool_connections', 'Knex DB pool connections by state', ['state']));
export const redisUp = registry.register(new Gauge('easygas_redis_up', 'Redis availability (1=up, 0=down)', []));
export const redisBackend = registry.register(new Gauge('easygas_redis_backend', 'Redis backend in use (value 1; kind label)', ['kind']));
export const readinessCheck = registry.register(new Gauge('easygas_readiness_check', 'Readiness sub-check status (1=ok, 0=fail)', ['check']));
export const readinessUp = registry.register(new Gauge('easygas_readiness_up', 'Overall readiness (1=ready, 0=not ready)', []));
export const unresolvedBlockingRisks = registry.register(new Gauge('easygas_unresolved_blocking_risks', 'Open blocking risks across current job cycles', []));
export const smsOutboxByStatus = registry.register(new Gauge('easygas_sms_outbox_messages', 'SMS outbox message count by status', ['status']));
export const processResidentMemoryBytes = registry.register(new Gauge('easygas_process_resident_memory_bytes', 'Resident set size in bytes', []));
export const processHeapUsedBytes = registry.register(new Gauge('easygas_process_heap_used_bytes', 'V8 heap used in bytes', []));
export const processUptimeSeconds = registry.register(new Gauge('easygas_process_uptime_seconds', 'Process uptime in seconds', []));
export const eventLoopLagSeconds = registry.register(new Gauge('easygas_nodejs_eventloop_lag_seconds', 'Approximate event-loop lag in seconds', []));

/** Maps a numeric HTTP status to a low-cardinality class label (2xx/3xx/4xx/5xx). */
export function statusClass(status: number): string {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  if (status >= 200) return '2xx';
  return '1xx';
}

// Event-loop lag sampler (cheap; ~every 5s). Uses setTimeout drift.
let lastLoopSample = Date.now();
const LOOP_INTERVAL_MS = 5000;
const loopTimer = setInterval(() => {
  const now = Date.now();
  const lag = Math.max(0, now - lastLoopSample - LOOP_INTERVAL_MS);
  eventLoopLagSeconds.set(lag / 1000);
  lastLoopSample = now;
}, LOOP_INTERVAL_MS);
loopTimer.unref?.();

// Process gauges are cheap to read at scrape time.
registry.addCollector(() => {
  const mem = process.memoryUsage();
  processResidentMemoryBytes.set(mem.rss);
  processHeapUsedBytes.set(mem.heapUsed);
  processUptimeSeconds.set(process.uptime());
});
