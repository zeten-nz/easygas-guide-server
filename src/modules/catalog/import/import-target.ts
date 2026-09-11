/**
 * Phase 11C — resolves the catalogue-import write target from the CLI flags and the
 * effective DB environment, fail-closed. Two apply modes, both refusing production:
 *
 *   --apply         → the isolated TEST database only (name ends "_test").
 *   --local-apply   → an explicit LOCAL DEVELOPMENT database: requires a local DB
 *                     host, a NON-production NODE_ENV, a non-"_test" name, and an
 *                     explicit `--confirm-db <name>` matching the configured DB_NAME.
 *
 * No flag → DRY_RUN (the default; writes nothing). This is pure/testable — no DB
 * access — so wrong-target/production rejection is unit-tested.
 */
export type ImportMode = 'DRY_RUN' | 'TEST_APPLY' | 'LOCAL_APPLY';

export interface TargetDecision {
  ok: boolean;
  mode: ImportMode;
  reason?: string;
}

export interface ImportFlags {
  apply: boolean;
  localApply: boolean;
  confirmDb?: string;
}

export interface DbEnv {
  dbName: string;
  dbHost: string;
  nodeEnv: string;
}

function isLocalHost(host: string): boolean {
  const h = (host || '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

export function resolveImportTarget(flags: ImportFlags, env: DbEnv): TargetDecision {
  const { apply, localApply, confirmDb } = flags;
  const dbName = env.dbName ?? '';
  const isTestDb = /_test$/.test(dbName);
  const isProd = env.nodeEnv === 'production';

  if (apply && localApply) {
    return { ok: false, mode: 'DRY_RUN', reason: 'Choose EITHER --apply (test DB) OR --local-apply (local dev DB), not both.' };
  }

  // Production is NEVER a write target for either mode — no rename/env trick bypasses this.
  if ((apply || localApply) && isProd) {
    return { ok: false, mode: 'DRY_RUN', reason: 'Refusing to write with NODE_ENV=production — production import is not authorized.' };
  }

  if (apply) {
    if (!isTestDb) {
      return { ok: false, mode: 'DRY_RUN', reason: `--apply writes ONLY to a *_test database (got "${dbName}"). Use --local-apply for a local development DB.` };
    }
    return { ok: true, mode: 'TEST_APPLY' };
  }

  if (localApply) {
    if (!isLocalHost(env.dbHost)) {
      return { ok: false, mode: 'DRY_RUN', reason: `--local-apply requires a LOCAL database host (got "${env.dbHost}"). Refusing a remote/shared target.` };
    }
    if (isTestDb) {
      return { ok: false, mode: 'DRY_RUN', reason: `--local-apply is for a local DEVELOPMENT database; "${dbName}" is a *_test database — use --apply instead.` };
    }
    if (!confirmDb) {
      return { ok: false, mode: 'DRY_RUN', reason: 'Refusing to --local-apply without --confirm-db <name>. Pass the EXACT target DB name to confirm.' };
    }
    if (confirmDb !== dbName) {
      return { ok: false, mode: 'DRY_RUN', reason: `--confirm-db "${confirmDb}" does not match the configured DB_NAME "${dbName}".` };
    }
    return { ok: true, mode: 'LOCAL_APPLY' };
  }

  return { ok: true, mode: 'DRY_RUN' };
}
