# Release Checklist — Phase 10F

The human-readable release checklist. It mirrors the automated release gate
(`npm run release:gate`). **There is no flag that bypasses a safety blocker.**

> ## KNOWN PRODUCTION BLOCKER (currently UNRESOLVED)
>
> The system **cannot** be declared production-ready while this stands. It is enforced by the
> **live** release gate:
>
> 1. **Risk matrix v1 is DRAFT.** It remains a draft until an **EasyGas safety specialist** reviews
>    and approves it. → gate check `ACTIVE + approved risk matrix` **BLOCKS**.
>
> **SMS is not a blocker in the normal configuration.** EasyGas uses manual admin password recovery
> and SMS is **disabled** (`SMS_PROVIDER` unset), so the gate's `sms_provider_functional` check does
> **not** block. It becomes a blocker **only if you enable SMS** (`SMS_PROVIDER=eskiz`) — the Eskiz
> adapter is still a fail-closed STUB pending a verified official spec, so leave SMS disabled
> unless/until that adapter lands.

---

## 1. The release gate — `npm run release:gate`

`scripts/release-gate.ts` produces both human-readable and machine (`--json`) output.

```bash
npm run release:gate            # human-readable
npm run release:gate -- --json  # machine-readable (CI / tooling)
```

**Exit codes:** `0` = READY, `3` = BLOCKED, `1` = error.

The gate has two kinds of blockers: **LIVE** (checked against the connected running system) and
**ATTESTED** (read from `release-attestation.json`). All must pass; **nothing can waive a LIVE
safety blocker.**

### LIVE blockers (checked against the running system)

| Check | Passes when |
|---|---|
| Migrations applied | No pending migrations on the connected DB — **bookkeeping only**, NOT a full schema verification (down/up is the attested `db_migrations_verified` in CI) |
| Risk matrix | Exactly one **ACTIVE + approved** matrix exists |
| SMS provider | Passes by default — SMS is **disabled** (manual admin recovery). Blocks **only when SMS is enabled** (`SMS_PROVIDER=eskiz`), where the fail-closed stub is not ready |
| Audit chain | `audit:verify` reports a **consistent** chain (tamper-evidence links verify) — NOT proof that no historical rows were lost (completeness is separate) |
| Readiness | `/ready` reports OK |
| Production config | Production configuration validates |

### ATTESTED blockers (from `release-attestation.json`)

Human/operational confirmations the gate cannot verify by itself. Each must be attested with WHO
and WHEN. They do **not** bypass the LIVE safety blockers.

| Attestation | Meaning |
|---|---|
| `ci_all_green` | Both repos' CI gates passed on the release commit |
| `db_migrations_verified` | Migration down/up verified for this release |
| `test_restore_succeeded` | A test restore from backup succeeded |
| `prod_npm_audit_meets_policy` | Prod dependency audit meets policy |
| `fullstack_playwright_passed` | The cross-repo full-stack E2E passed |
| `backup_configured_and_restore_tested` | Backups configured and a restore was tested |
| `nginx_firewall_trustproxy_verified` | Nginx/firewall/trust-proxy configuration verified |
| `production_secrets_distinct_strong` | All production secrets are distinct and strong |
| `monitoring_alerts_configured` | Monitoring/alerting configured |
| `manual_smoke_signed_off` | Manual smoke test signed off |

---

## 2. Filling in `release-attestation.json`

The file is **git-ignored**. Copy the template and fill each item with who attested and when:

```bash
cp release-attestation.example.json release-attestation.json
# edit release-attestation.json — set "attested": true, "by": "<name>", "at": "<ISO timestamp>"
```

Template shape (`release-attestation.example.json`):

```json
{
  "release": {
    "client_sha": "",
    "server_sha": "",
    "ci_run": "",
    "e2e_run": "",
    "restore_drill": ""
  },
  "attestations": {
    "ci_all_green":                        { "attested": false, "by": "", "at": "" },
    "db_migrations_verified":              { "attested": false, "by": "", "at": "" },
    "test_restore_succeeded":              { "attested": false, "by": "", "at": "" },
    "prod_npm_audit_meets_policy":         { "attested": false, "by": "", "at": "" },
    "fullstack_playwright_passed":         { "attested": false, "by": "", "at": "" },
    "backup_configured_and_restore_tested":{ "attested": false, "by": "", "at": "" },
    "nginx_firewall_trustproxy_verified":  { "attested": false, "by": "", "at": "" },
    "production_secrets_distinct_strong":  { "attested": false, "by": "", "at": "" },
    "monitoring_alerts_configured":        { "attested": false, "by": "", "at": "" },
    "manual_smoke_signed_off":             { "attested": false, "by": "", "at": "" }
  }
}
```

> The `release` block is a traceability **binding** — the exact `client_sha` / `server_sha` and the
> `ci_run` / `e2e_run` / `restore_drill` references this release covers. The gate **echoes** it (it
> does not verify a CI/attestation service) and warns if it is unset; it is **never** auto-filled.
> Attesting an item you did not actually verify defeats the purpose. Each attestation is an
> operational confirmation on the record.

---

## 3. Pre-release checklist (operator)

Work top-to-bottom; every item maps to a gate check or an attestation.

- [ ] Both CI gates green on the release commit (`server-ci`, `client-ci`) → `ci_all_green`
- [ ] Cross-repo full-stack E2E run and passing → `fullstack_playwright_passed`
- [ ] Migrations applied on target DB; down/up verified → LIVE *migrations* + `db_migrations_verified`
- [ ] **Risk matrix v1 approved by an EasyGas safety specialist and ACTIVE** → LIVE *risk matrix* **(BLOCKER)**
- [ ] SMS: **disabled by default (no action)**. *Only if enabling SMS* (`SMS_PROVIDER=eskiz`): real Eskiz adapter implemented against a verified spec + `smsCapability` ready → LIVE *SMS* **(BLOCKER while enabled)**
- [ ] `npm run audit:verify` clean; off-server checkpoint anchored → LIVE *audit chain*
- [ ] `/ready` OK against the target system → LIVE *readiness*
- [ ] Production config validates (`METRICS_TOKEN` set if metrics enabled, etc.) → LIVE *prod config*
- [ ] Prod `npm audit` meets policy (both repos) → `prod_npm_audit_meets_policy`
- [ ] Backups configured; a restore tested → `backup_configured_and_restore_tested` + `test_restore_succeeded`
- [ ] Nginx / firewall / `TRUST_PROXY_HOPS` verified; `/metrics` off the public vhost → `nginx_firewall_trustproxy_verified`
- [ ] All production secrets distinct + strong → `production_secrets_distinct_strong`
- [ ] Monitoring/alerting configured → `monitoring_alerts_configured`
- [ ] Manual smoke test signed off → `manual_smoke_signed_off`
- [ ] Branch protection recommendations applied (see `CI-RELEASE-10F.md` §E)
- [ ] `npm run release:gate` exits **0 (READY)**

---

## 4. Run it

```bash
npm run release:gate
# exit 0 → READY   |   exit 3 → BLOCKED (read the report)   |   exit 1 → error
```

The gate's verification model is **preflight** (config / migrations / this gate) **+ a post-start
smoke on the PRIVATE port before public cutover** — it never requires opening public traffic to
verify.

Until the KNOWN BLOCKER (the DRAFT risk matrix) is resolved and the attested inputs are recorded,
the gate will exit **3 (BLOCKED)** — as intended. There is no escape flag. (Enabling SMS re-adds the
functional-SMS-provider blocker until the real Eskiz adapter lands.)
