import { db } from '../../config/database';
import { smsFeatureEnabled } from '../../config/env';
import { getRedis } from '../../redis/redis';
import { getStorageProvider } from '../../storage';
import { smsCapability } from '../../sms';
import { riskPolicyActive } from '../risk/risk-policy.service';

/**
 * Phase 10C liveness/readiness.
 *
 * Liveness proves the event loop can answer and depends on nothing external.
 * Readiness answers "should this instance receive traffic?" — it checks each
 * dependency with a strict per-check timeout and an overall timeout, and flips
 * to not-ready during graceful shutdown. Neither exposes credentials, hostnames,
 * schema names or stack traces.
 */

let shuttingDown = false;
export function setShuttingDown(v: boolean): void {
  shuttingDown = v;
}
export function isShuttingDown(): boolean {
  return shuttingDown;
}

const PER_CHECK_MS = 2_000;
const OVERALL_MS = 5_000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      t.unref?.();
    }),
  ]);
}

async function checkDb(): Promise<boolean> {
  try {
    await withTimeout(db.raw('SELECT 1'), PER_CHECK_MS);
    return true;
  } catch {
    return false;
  }
}

async function checkRedis(): Promise<boolean> {
  try {
    const pong = await withTimeout(getRedis().ping(), PER_CHECK_MS);
    return pong === 'PONG';
  } catch {
    return false;
  }
}

async function checkStorage(): Promise<boolean> {
  try {
    // A stat of a non-existent key resolves (null) when the store is reachable,
    // and throws only on a real connectivity/permission problem. Non-destructive.
    await withTimeout(getStorageProvider().stat('.readiness-probe-nonexistent'), PER_CHECK_MS);
    return true;
  } catch {
    return false;
  }
}

function checkSmsConfig(): boolean {
  try {
    // The ACTUAL provider capability — never faked. Reported honestly even when
    // SMS is disabled (then it simply does not gate readiness; see readiness()).
    return smsCapability().ready;
  } catch {
    return false;
  }
}

async function checkRiskPolicy(): Promise<boolean> {
  try {
    return await withTimeout(riskPolicyActive(), PER_CHECK_MS);
  } catch {
    return false;
  }
}

export interface Readiness {
  ready: boolean;
  checks: {
    db: boolean;
    redis: boolean;
    storage: boolean;
    /** Actual provider capability (honest). Gates readiness ONLY when smsRequired. */
    sms: boolean;
    /** Whether any enabled feature uses SMS (false after manual recovery replaced OTP). */
    smsRequired: boolean;
    riskPolicy: boolean;
    shuttingDown: boolean;
  };
}

export async function readiness(): Promise<Readiness> {
  const smsRequired = smsFeatureEnabled();
  if (shuttingDown) {
    return {
      ready: false,
      checks: { db: false, redis: false, storage: false, sms: false, smsRequired, riskPolicy: false, shuttingDown: true },
    };
  }
  let db_ = false;
  let redis_ = false;
  let storage_ = false;
  let sms_ = false;
  let riskPolicy_ = false;
  try {
    [db_, redis_, storage_, riskPolicy_] = await withTimeout(
      Promise.all([checkDb(), checkRedis(), checkStorage(), checkRiskPolicy()]),
      OVERALL_MS,
    );
    sms_ = checkSmsConfig();
  } catch {
    // Overall timeout — leave failed checks false.
    sms_ = checkSmsConfig();
  }
  // §E — SMS gates readiness ONLY when an enabled feature actually uses it. When
  // disabled, a non-usable provider (sms=false) does NOT block readiness, and we
  // never fake sms=true. Phase 10D: the safety domain is NOT reported healthy
  // without an approved risk policy (riskPolicy=false fails closed here too).
  const ready = db_ && redis_ && storage_ && riskPolicy_ && (!smsRequired || sms_);
  return {
    ready,
    checks: { db: db_, redis: redis_, storage: storage_, sms: sms_, smsRequired, riskPolicy: riskPolicy_, shuttingDown: false },
  };
}
