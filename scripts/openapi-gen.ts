/**
 * Phase 10F — generate the committed OpenAPI document from the single TS
 * source of truth (src/openapi/spec.ts). Run: `npm run openapi:gen`.
 * The generated docs/openapi.json is committed; `npm run openapi:check` fails if
 * it drifts from the source (so contract changes are always visible in review).
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openapiSpec } from '../src/openapi/spec';

const out = resolve(__dirname, '..', 'docs', 'openapi.json');
const json = JSON.stringify(openapiSpec, null, 2) + '\n';
writeFileSync(out, json, 'utf8');
const opCount = Object.values(openapiSpec.paths ?? {}).reduce<number>(
  (n, item) => n + Object.keys(item as Record<string, unknown>).filter((k) => ['get', 'post', 'put', 'patch', 'delete'].includes(k)).length,
  0,
);
console.log(`Wrote ${out} (${opCount} operations, ${Object.keys(openapiSpec.paths ?? {}).length} paths)`);
