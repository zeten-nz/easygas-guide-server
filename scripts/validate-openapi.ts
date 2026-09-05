/**
 * Phase 10F — OpenAPI contract validation + drift detection.
 *   npm run openapi:check
 *
 * Verifies: (1) valid OpenAPI 3.1 structure, (2) unique operationIds,
 * (3) every internal $ref resolves, (4) the committed docs/openapi.json is up to
 * date with the source (src/openapi/spec.ts), and (5) ROUTE DRIFT — every
 * implemented Express route is documented and vice versa (the intentionally
 * internal /metrics endpoint is excluded). Read-only. Exit non-zero on any
 * problem. Does not require a database connection.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openapiSpec } from '../src/openapi/spec';
import { createApp } from '../src/app';

const problems: string[] = [];
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// Feature-router mount paths in EXACT app.ts registration order. If a router is
// added/removed in app.ts without updating this list, the count check below trips.
const MOUNTS = [
  '/api/v1/auth',
  '/api/v1/users',
  '/api/v1/branches',
  '/api/v1/customers',
  '/api/v1/vehicles',
  '/api/v1/jobs/:jobId/checklist/steps/:stepId/photos',
  '/api/v1/jobs/:jobId/checklist',
  '/api/v1/jobs/:jobId/stop',
  '/api/v1/jobs/:jobId/risks',
  '/api/v1/jobs/:jobId/gps',
  '/api/v1/jobs/:jobId/quality',
  '/api/v1/jobs',
  '/api/v1/checklist-templates',
  '/api/v1/risk-policy',
  '/api/v1/admin/registration-requests',
];

// Implemented routes that are intentionally NOT part of the public contract.
const UNDOCUMENTED = new Set(['GET /api/v1/metrics']);

/** Common normal form: strip trailing slash; params → {x}. */
function norm(path: string): string {
  const p = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

// ---- 1. structure ----
const spec = openapiSpec as Record<string, any>;
if (!spec.openapi || !String(spec.openapi).startsWith('3.1')) problems.push(`openapi must be 3.1.x (got ${spec.openapi})`);
if (!spec.info?.title || !spec.info?.version) problems.push('info.title and info.version are required');
if (!spec.paths || Object.keys(spec.paths).length === 0) problems.push('paths must be non-empty');
const serverPrefix: string = spec.servers?.[0]?.url ?? '';

// ---- 2. unique operationIds ----
const ids = new Map<string, number>();
for (const item of Object.values(spec.paths ?? {})) {
  for (const [m, op] of Object.entries(item as Record<string, any>)) {
    if (!HTTP_METHODS.includes(m)) continue;
    const id = op?.operationId;
    if (!id) problems.push(`missing operationId on a ${m.toUpperCase()} operation`);
    else ids.set(id, (ids.get(id) ?? 0) + 1);
  }
}
for (const [id, n] of ids) if (n > 1) problems.push(`duplicate operationId: ${id} (${n}x)`);

// ---- 3. $ref resolution (internal refs only) ----
function collectRefs(node: unknown, acc: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((n) => collectRefs(n, acc));
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string') acc.push(v);
    else collectRefs(v, acc);
  }
}
const refs: string[] = [];
collectRefs(spec, refs);
for (const ref of refs) {
  if (!ref.startsWith('#/')) {
    problems.push(`external $ref not allowed: ${ref}`);
    continue;
  }
  const parts = ref.slice(2).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: any = spec;
  for (const part of parts) {
    cur = cur?.[part];
    if (cur === undefined) {
      problems.push(`unresolved $ref: ${ref}`);
      break;
    }
  }
}

// ---- 4. up-to-date with the committed file ----
const committedPath = resolve(__dirname, '..', 'docs', 'openapi.json');
try {
  const committed = readFileSync(committedPath, 'utf8');
  const expected = JSON.stringify(openapiSpec, null, 2) + '\n';
  if (committed !== expected) problems.push('docs/openapi.json is out of date — run `npm run openapi:gen` and commit the result');
} catch {
  problems.push('docs/openapi.json is missing — run `npm run openapi:gen`');
}

// ---- 5. route drift (implemented vs documented) ----
function extractRoutes(): Set<string> {
  const app = createApp() as any;
  const router = app.router ?? app._router;
  const found = new Set<string>();
  const routerLayers: any[] = [];
  for (const layer of router.stack) {
    if (layer.route) {
      // top-level app routes (health/metrics/ready)
      for (const m of Object.keys(layer.route.methods)) {
        if (layer.route.methods[m]) found.add(`${m.toUpperCase()} ${norm(layer.route.path)}`);
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      routerLayers.push(layer);
    }
  }
  if (routerLayers.length !== MOUNTS.length) {
    problems.push(`router count drift: app has ${routerLayers.length} feature routers, MOUNTS lists ${MOUNTS.length} — update validate-openapi MOUNTS to match app.ts`);
  }
  routerLayers.forEach((layer, i) => {
    const mount = MOUNTS[i];
    if (!mount) return;
    for (const sub of layer.handle.stack) {
      if (!sub.route) continue;
      const leaf = sub.route.path === '/' ? '' : sub.route.path;
      const full = norm(mount + leaf);
      for (const m of Object.keys(sub.route.methods)) {
        if (sub.route.methods[m]) found.add(`${m.toUpperCase()} ${full}`);
      }
    }
  });
  return found;
}

function documentedRoutes(): Set<string> {
  const out = new Set<string>();
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    for (const m of Object.keys(item as Record<string, any>)) {
      if (!HTTP_METHODS.includes(m)) continue;
      out.add(`${m.toUpperCase()} ${norm(serverPrefix + p)}`);
    }
  }
  return out;
}

try {
  const implemented = extractRoutes();
  const documented = documentedRoutes();
  for (const r of implemented) {
    if (UNDOCUMENTED.has(r)) continue;
    if (!documented.has(r)) problems.push(`route implemented but NOT documented: ${r}`);
  }
  for (const r of documented) {
    if (!implemented.has(r)) problems.push(`route documented but NOT implemented: ${r}`);
  }
} catch (err) {
  problems.push(`route extraction failed: ${err instanceof Error ? err.message : String(err)}`);
}

// ---- report ----
if (problems.length === 0) {
  console.log(`OpenAPI OK — ${ids.size} operations, ${Object.keys(spec.paths ?? {}).length} paths, all refs resolve, no route drift.`);
  process.exit(0);
} else {
  console.error(`OpenAPI validation FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(2);
}
