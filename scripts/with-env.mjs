#!/usr/bin/env node
/**
 * with-env — safely load an env file and exec a command with the merged env.
 *
 * WHY: a dotenv file is NOT shell code. `set -a; . .env; set +a` (sourcing) runs
 * the file through the shell, so a value containing $(...), backticks, spaces or
 * quotes is EXECUTED or mangled. This helper parses the file with dotenv's parser
 * (plain KEY=VALUE, no shell evaluation) and spawns the command directly (no
 * shell), so secrets with special characters are passed through correctly.
 *
 * Precedence matches the app (src/config/env.ts): variables already in the
 * environment WIN over the file, so an operator/PM2 override is respected.
 *
 * Usage (cron / operators):
 *     node scripts/with-env.mjs bash scripts/backup-mysql.sh
 *     ENV_FILE=/srv/easygas/server/.env node scripts/with-env.mjs npm run cleanup -- --apply
 *
 * ENV_FILE selects the file (default: ".env" in the current directory).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';

const envFile = process.env.ENV_FILE || '.env';
let fileVars = {};
try {
  fileVars = parse(readFileSync(envFile));
} catch (err) {
  console.error(`with-env: cannot read env file "${envFile}": ${err.message}`);
  process.exit(1);
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('with-env: usage: node scripts/with-env.mjs <command> [args...]');
  process.exit(2);
}

// Existing environment wins over the file (same as dotenv's non-override default).
const mergedEnv = { ...fileVars, ...process.env };

const result = spawnSync(cmd, args, { stdio: 'inherit', env: mergedEnv, shell: false });
if (result.error) {
  console.error(`with-env: failed to run "${cmd}": ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  console.error(`with-env: "${cmd}" terminated by signal ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
