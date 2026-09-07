import type { Request, Response, NextFunction } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { db } from '../config/database';
import { getRedis } from '../redis/redis';
import { env, isProduction } from '../config/env';
import { readiness } from '../modules/health/health.service';
import {
  registry,
  httpRequestsTotal,
  httpRequestDuration,
  statusClass,
  dbPoolConnections,
  redisUp,
  redisBackend,
  readinessCheck,
  readinessUp,
  unresolvedBlockingRisks,
  smsOutboxByStatus,
} from './metrics';

/**
 * Phase 10F observability wiring: request/correlation IDs, HTTP metrics with
 * LOW-CARDINALITY route templates, scrape-time runtime gauges, and a token-gated
 * /metrics handler that is never public in production.
 */

/** A conservative inbound request-id (trace propagation) — else a fresh UUID. */
export function resolveRequestId(req: Request): string {
  const inbound = req.headers['x-request-id'];
  if (typeof inbound === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(inbound)) return inbound;
  return randomUUID();
}

/** pino-http genReqId: reuse/echo the correlation id and set it on the response. */
export function genReqId(req: Request, res: Response): string {
  const id = resolveRequestId(req);
  res.setHeader('x-request-id', id);
  return id;
}

const SEEN_ROUTES = new Set<string>();
const MAX_DISTINCT_ROUTES = 200; // cardinality backstop

/**
 * Collapses a concrete URL to a low-cardinality route TEMPLATE:
 * numeric id segments → :id, the risk-policy version → :version. A hard cap
 * guards against any unexpected cardinality explosion (→ "/other").
 */
export function normalizeRoute(originalUrl: string): string {
  const path = originalUrl.split('?')[0];
  let p = path.replace(/\/risk-policy\/[^/]+\/(activate|retire)/, '/risk-policy/:version/$1');
  p = p.replace(/\/\d+(?=\/|$)/g, '/:id');
  if (!SEEN_ROUTES.has(p)) {
    if (SEEN_ROUTES.size >= MAX_DISTINCT_ROUTES) return '/other';
    SEEN_ROUTES.add(p);
  }
  return p;
}

/** Records HTTP request count + duration by method, route template and status class. */
export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip infra endpoints to keep the series clean.
  if (req.path === '/api/v1/health' || req.path === '/api/v1/ready' || req.path === '/api/v1/metrics') {
    next();
    return;
  }
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = { method: req.method, route: normalizeRoute(req.originalUrl), status_class: statusClass(res.statusCode) };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, durationSec);
  });
  next();
}

/** Refreshes pull-style gauges. Every step is guarded so a scrape never fails. */
export async function refreshRuntimeGauges(): Promise<void> {
  // DB pool (in-memory, cheap).
  try {
    const pool = (db.client as unknown as { pool?: { numUsed(): number; numFree(): number; numPendingAcquires(): number; numPendingCreates(): number } }).pool;
    if (pool) {
      dbPoolConnections.set({ state: 'used' }, pool.numUsed());
      dbPoolConnections.set({ state: 'free' }, pool.numFree());
      dbPoolConnections.set({ state: 'pending_acquire' }, pool.numPendingAcquires());
      dbPoolConnections.set({ state: 'pending_create' }, pool.numPendingCreates());
    }
  } catch { /* ignore */ }

  // Redis backend kind (sync).
  try {
    redisBackend.set({ kind: getRedis().kind }, 1);
  } catch { /* ignore */ }

  // Readiness (has its own internal timeouts) → overall + per-check + redis up.
  try {
    const r = await readiness();
    readinessUp.set(r.ready ? 1 : 0);
    for (const [check, ok] of Object.entries(r.checks)) readinessCheck.set({ check }, ok ? 1 : 0);
    redisUp.set(r.checks.redis ? 1 : 0);
  } catch { /* ignore */ }

  // Unresolved blocking risks (bounded query).
  try {
    const rows = (await db('risk_events').whereIn('status', ['OPEN', 'MITIGATION_IN_PROGRESS']).where({ blocking: true }).count({ c: '*' })) as [{ c: number | string }];
    unresolvedBlockingRisks.set(Number(rows[0]?.c ?? 0));
  } catch { /* ignore */ }

  // SMS outbox by status (bounded aggregate).
  try {
    const rows = (await db('sms_outbox').select('status').count({ c: '*' }).groupBy('status')) as { status: string; c: number | string }[];
    for (const row of rows) smsOutboxByStatus.set({ status: row.status }, Number(row.c));
  } catch { /* ignore */ }
}

function tokenAllowed(req: Request): boolean {
  const configured = env.METRICS_TOKEN;
  if (configured) {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/.exec(header);
    if (!m) return false;
    const provided = Buffer.from(m[1]);
    const expected = Buffer.from(configured);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }
  // No token configured: allow only in non-production (dev/test convenience);
  // NEVER expose metrics publicly in production without an explicit token.
  return !isProduction;
}

/**
 * Token-gated Prometheus exposition. Returns 404 (not 401) when unauthorized so
 * the endpoint's existence is not advertised. Never public in production without
 * METRICS_TOKEN; the deploy layer must additionally keep it off the public vhost.
 */
export async function metricsHandler(req: Request, res: Response): Promise<void> {
  if (!env.METRICS_ENABLED || !tokenAllowed(req)) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint topilmadi' } });
    return;
  }
  await refreshRuntimeGauges();
  const body = await registry.expose();
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
}
