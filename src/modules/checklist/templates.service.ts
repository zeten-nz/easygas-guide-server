import type { Knex } from 'knex';
import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import type { AuthUser } from '../../types/auth';
import type { CreateTemplateInput, MeasurementDefInput, StepInput } from './templates.validators';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export type VersionStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export interface MeasurementDefDetail {
  id: number;
  name: string;
  unit: string;
  minValue: number | null;
  maxValue: number | null;
  expectedValue: number | null;
  required: boolean;
}

export interface StepDetail {
  id: number;
  sortOrder: number;
  name: string;
  description: string | null;
  requirements: string | null;
  isStop: boolean;
  riskWeight: number;
  requiredPhotos: number;
  measurements: MeasurementDefDetail[];
}

export interface VersionDetail {
  id: number;
  version: number;
  status: VersionStatus;
  publishedAt: Date | null;
  stepCount: number;
  steps?: StepDetail[];
}

/** Why a template cannot be permanently deleted (null = eligible). */
export type DeletableReason = 'HAS_PUBLISHED_OR_ARCHIVED_HISTORY';

export interface TemplateDetail {
  id: number;
  name: string;
  description: string | null;
  versions: VersionDetail[];
  /**
   * §D deletion eligibility (ADVISORY — the DELETE endpoint re-checks under a lock).
   * A template is permanently deletable ONLY when every version is still DRAFT, i.e.
   * nothing was ever published: a DRAFT-only template can never have been assigned to
   * a job (assignment requires a PUBLISHED version), so no history references it.
   * A published/archived version means history must be preserved (archive, not delete).
   */
  deletable: boolean;
  deletableReason: DeletableReason | null;
}

/** Advisory eligibility from a template's version statuses (see TemplateDetail). */
function deletability(statuses: VersionStatus[]): { deletable: boolean; deletableReason: DeletableReason | null } {
  const deletable = statuses.every((s) => s === 'DRAFT');
  return { deletable, deletableReason: deletable ? null : 'HAS_PUBLISHED_OR_ARCHIVED_HISTORY' };
}

function toDecimal(v: unknown): number | null {
  return v == null ? null : Number(v);
}

export function toMeasurementDetail(row: Record<string, unknown>): MeasurementDefDetail {
  return {
    id: row.id as number,
    name: row.name as string,
    unit: row.unit as string,
    minValue: toDecimal(row.min_value),
    maxValue: toDecimal(row.max_value),
    expectedValue: toDecimal(row.expected_value),
    required: Boolean(row.required),
  };
}

export async function loadStepsWithMeasurements(
  versionIds: number[],
  trx?: Knex.Transaction,
): Promise<Map<number, StepDetail[]>> {
  const conn = trx ?? db;
  const steps = await conn('checklist_steps').whereIn('version_id', versionIds).orderBy(['version_id', 'sort_order']);
  const stepIds = steps.map((s: { id: number }) => s.id);
  const measurements = stepIds.length > 0 ? await conn('checklist_step_measurements').whereIn('step_id', stepIds).orderBy('id') : [];

  const byStep = new Map<number, MeasurementDefDetail[]>();
  for (const m of measurements) {
    const list = byStep.get(m.step_id) ?? [];
    list.push(toMeasurementDetail(m));
    byStep.set(m.step_id, list);
  }

  const byVersion = new Map<number, StepDetail[]>();
  for (const s of steps) {
    const list = byVersion.get(s.version_id) ?? [];
    list.push({
      id: s.id,
      sortOrder: s.sort_order,
      name: s.name,
      description: s.description,
      requirements: s.requirements,
      isStop: Boolean(s.is_stop),
      riskWeight: s.risk_weight,
      requiredPhotos: s.required_photos,
      measurements: byStep.get(s.id) ?? [],
    });
    byVersion.set(s.version_id, list);
  }
  return byVersion;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listTemplates(): Promise<TemplateDetail[]> {
  const templates = await db('checklist_templates').orderBy('name');
  const versions = (await db('checklist_template_versions')
    .select('checklist_template_versions.*')
    .count({ step_count: 'checklist_steps.id' })
    .leftJoin('checklist_steps', 'checklist_steps.version_id', 'checklist_template_versions.id')
    .groupBy('checklist_template_versions.id')
    .orderBy('checklist_template_versions.version')) as Record<string, unknown>[];

  return templates.map((t: Record<string, unknown>) => {
    const vs = versions
      .filter((v) => v.template_id === t.id)
      .map((v) => ({
        id: v.id as number,
        version: v.version as number,
        status: v.status as VersionStatus,
        publishedAt: v.published_at as Date | null,
        stepCount: Number(v.step_count ?? 0),
      }));
    return {
      id: t.id as number,
      name: t.name as string,
      description: t.description as string | null,
      versions: vs,
      ...deletability(vs.map((v) => v.status)),
    };
  });
}

export async function getTemplate(id: number): Promise<TemplateDetail> {
  const template = await db('checklist_templates').where({ id }).first();
  if (!template) throw ApiError.notFound('Shablon topilmadi');

  const versions = await db('checklist_template_versions').where({ template_id: id }).orderBy('version');
  const stepsByVersion = await loadStepsWithMeasurements(versions.map((v: { id: number }) => v.id));

  const mapped = versions.map((v: Record<string, unknown>) => {
    const steps = stepsByVersion.get(v.id as number) ?? [];
    return {
      id: v.id as number,
      version: v.version as number,
      status: v.status as VersionStatus,
      publishedAt: v.published_at as Date | null,
      stepCount: steps.length,
      steps,
    };
  });

  return {
    id: template.id,
    name: template.name,
    description: template.description,
    versions: mapped,
    ...deletability(mapped.map((v) => v.status)),
  };
}

/** Templates that currently have a PUBLISHED version — used by the assignment picker. */
export async function listAssignableTemplates(): Promise<{ id: number; name: string; version: number }[]> {
  const rows = await db('checklist_templates')
    .select('checklist_templates.id', 'checklist_templates.name', 'checklist_template_versions.version')
    .join('checklist_template_versions', function join() {
      this.on('checklist_template_versions.template_id', 'checklist_templates.id').andOnVal(
        'checklist_template_versions.status',
        'PUBLISHED',
      );
    })
    .orderBy('checklist_templates.name');
  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as number,
    name: r.name as string,
    version: r.version as number,
  }));
}

// ---------------------------------------------------------------------------
// Mutations (ADMIN via templates.manage)
// ---------------------------------------------------------------------------

export async function createTemplate(actor: AuthUser, input: CreateTemplateInput, meta: RequestMeta): Promise<TemplateDetail> {
  const existing = await db('checklist_templates').whereRaw('LOWER(name) = LOWER(?)', [input.name]).first();
  if (existing) throw ApiError.conflict('Bu nomdagi shablon allaqachon mavjud', 'TEMPLATE_NAME_TAKEN');

  const id = await db.transaction(async (trx) => {
    const [newId] = await trx('checklist_templates').insert({
      name: input.name,
      description: input.description ?? null,
      created_by: actor.id,
    });
    // Every template starts with an empty DRAFT v1 ready for steps.
    await trx('checklist_template_versions').insert({
      template_id: newId,
      version: 1,
      status: 'DRAFT',
      created_by: actor.id,
    });
    await logAudit(
      {
        userId: actor.id,
        action: 'TEMPLATE_CREATED',
        entityType: 'checklist_template',
        entityId: newId,
        newValue: { name: input.name },
        ...meta,
      },
      trx,
    );
    return newId as number;
  });

  return getTemplate(id);
}

/**
 * Creates the next DRAFT version. Steps are copied from the latest existing
 * version so the admin edits a working copy instead of retyping everything.
 * Only one DRAFT per template at a time keeps versioning unambiguous.
 */
export async function createVersion(actor: AuthUser, templateId: number, meta: RequestMeta): Promise<TemplateDetail> {
  await db.transaction(async (trx) => {
    const template = await trx('checklist_templates').where({ id: templateId }).forUpdate().first();
    if (!template) throw ApiError.notFound('Shablon topilmadi');

    const existingDraft = await trx('checklist_template_versions')
      .where({ template_id: templateId, status: 'DRAFT' })
      .first();
    if (existingDraft) {
      throw ApiError.conflict('Bu shablonda tahrirlanmagan qoralama versiya allaqachon mavjud', 'DRAFT_EXISTS');
    }

    const latest = await trx('checklist_template_versions')
      .where({ template_id: templateId })
      .orderBy('version', 'desc')
      .first();
    const nextVersion = (latest?.version ?? 0) + 1;

    const [versionId] = await trx('checklist_template_versions').insert({
      template_id: templateId,
      version: nextVersion,
      status: 'DRAFT',
      created_by: actor.id,
    });

    // Copy steps + measurement definitions from the latest version (if any).
    if (latest) {
      const steps = await trx('checklist_steps').where({ version_id: latest.id }).orderBy('sort_order');
      for (const step of steps) {
        const [newStepId] = await trx('checklist_steps').insert({
          version_id: versionId,
          sort_order: step.sort_order,
          name: step.name,
          description: step.description,
          requirements: step.requirements,
          is_stop: step.is_stop,
          risk_weight: step.risk_weight,
          required_photos: step.required_photos,
        });
        const defs = await trx('checklist_step_measurements').where({ step_id: step.id }).orderBy('id');
        for (const def of defs) {
          await trx('checklist_step_measurements').insert({
            step_id: newStepId,
            name: def.name,
            unit: def.unit,
            min_value: def.min_value,
            max_value: def.max_value,
            expected_value: def.expected_value,
            required: def.required,
          });
        }
      }
    }

    await logAudit(
      {
        userId: actor.id,
        action: 'TEMPLATE_VERSION_CREATED',
        entityType: 'checklist_template_version',
        entityId: versionId,
        newValue: { templateId, version: nextVersion, copiedFrom: latest?.version ?? null },
        ...meta,
      },
      trx,
    );
  });

  return getTemplate(templateId);
}

/** Loads a version row-locked and asserts it belongs to the template and is DRAFT. */
async function lockDraftVersion(trx: Knex.Transaction, templateId: number, versionId: number) {
  const version = await trx('checklist_template_versions')
    .where({ id: versionId, template_id: templateId })
    .forUpdate()
    .first();
  if (!version) throw ApiError.notFound('Versiya topilmadi');
  if (version.status !== 'DRAFT') {
    // Immutability guarantee (§41): published/archived versions can never change.
    throw ApiError.conflict("Faqat qoralama (DRAFT) versiyani tahrirlash mumkin", 'VERSION_NOT_DRAFT');
  }
  return version;
}

async function insertMeasurements(trx: Knex.Transaction, stepId: number, defs: MeasurementDefInput[]) {
  for (const def of defs) {
    await trx('checklist_step_measurements').insert({
      step_id: stepId,
      name: def.name,
      unit: def.unit,
      min_value: def.minValue ?? null,
      max_value: def.maxValue ?? null,
      expected_value: def.expectedValue ?? null,
      required: def.required,
    });
  }
}

export async function addStep(
  actor: AuthUser,
  templateId: number,
  versionId: number,
  input: StepInput,
  meta: RequestMeta,
): Promise<TemplateDetail> {
  await db.transaction(async (trx) => {
    await lockDraftVersion(trx, templateId, versionId);
    const [{ maxOrder }] = (await trx('checklist_steps')
      .where({ version_id: versionId })
      .max({ maxOrder: 'sort_order' })) as [{ maxOrder: number | null }];

    const [stepId] = await trx('checklist_steps').insert({
      version_id: versionId,
      sort_order: (maxOrder ?? 0) + 1,
      name: input.name,
      description: input.description ?? null,
      requirements: input.requirements ?? null,
      is_stop: input.isStop,
      risk_weight: input.riskWeight,
      required_photos: input.requiredPhotos,
    });
    await insertMeasurements(trx, stepId as number, input.measurements);

    await logAudit(
      {
        userId: actor.id,
        action: 'TEMPLATE_STEP_CHANGED',
        entityType: 'checklist_template_version',
        entityId: versionId,
        newValue: { op: 'add', stepId, name: input.name },
        ...meta,
      },
      trx,
    );
  });

  return getTemplate(templateId);
}

export async function updateStep(
  actor: AuthUser,
  templateId: number,
  versionId: number,
  stepId: number,
  input: StepInput,
  meta: RequestMeta,
): Promise<TemplateDetail> {
  await db.transaction(async (trx) => {
    await lockDraftVersion(trx, templateId, versionId);
    const step = await trx('checklist_steps').where({ id: stepId, version_id: versionId }).first();
    if (!step) throw ApiError.notFound('Bosqich topilmadi');

    await trx('checklist_steps').where({ id: stepId }).update({
      name: input.name,
      description: input.description ?? null,
      requirements: input.requirements ?? null,
      is_stop: input.isStop,
      risk_weight: input.riskWeight,
      required_photos: input.requiredPhotos,
      updated_at: trx.fn.now(),
    });
    // Draft-only editing: replacing definitions is safe — no execution rows
    // can reference a DRAFT version's measurements.
    await trx('checklist_step_measurements').where({ step_id: stepId }).del();
    await insertMeasurements(trx, stepId, input.measurements);

    await logAudit(
      {
        userId: actor.id,
        action: 'TEMPLATE_STEP_CHANGED',
        entityType: 'checklist_template_version',
        entityId: versionId,
        newValue: { op: 'update', stepId, name: input.name },
        ...meta,
      },
      trx,
    );
  });

  return getTemplate(templateId);
}

export async function deleteStep(
  actor: AuthUser,
  templateId: number,
  versionId: number,
  stepId: number,
  meta: RequestMeta,
): Promise<TemplateDetail> {
  await db.transaction(async (trx) => {
    await lockDraftVersion(trx, templateId, versionId);
    const step = await trx('checklist_steps').where({ id: stepId, version_id: versionId }).first();
    if (!step) throw ApiError.notFound('Bosqich topilmadi');

    await trx('checklist_steps').where({ id: stepId }).del(); // measurements cascade
    // Renormalize ordering to 1..N so sequence stays deterministic.
    const remaining = await trx('checklist_steps').where({ version_id: versionId }).orderBy('sort_order');
    for (let i = 0; i < remaining.length; i += 1) {
      if (remaining[i].sort_order !== i + 1) {
        await trx('checklist_steps').where({ id: remaining[i].id }).update({ sort_order: i + 1 });
      }
    }

    await logAudit(
      {
        userId: actor.id,
        action: 'TEMPLATE_STEP_CHANGED',
        entityType: 'checklist_template_version',
        entityId: versionId,
        newValue: { op: 'delete', stepId, name: step.name },
        ...meta,
      },
      trx,
    );
  });

  return getTemplate(templateId);
}

export async function moveStep(
  actor: AuthUser,
  templateId: number,
  versionId: number,
  stepId: number,
  direction: 'up' | 'down',
  meta: RequestMeta,
): Promise<TemplateDetail> {
  await db.transaction(async (trx) => {
    await lockDraftVersion(trx, templateId, versionId);
    const step = await trx('checklist_steps').where({ id: stepId, version_id: versionId }).first();
    if (!step) throw ApiError.notFound('Bosqich topilmadi');

    const neighborOrder = direction === 'up' ? step.sort_order - 1 : step.sort_order + 1;
    const neighbor = await trx('checklist_steps').where({ version_id: versionId, sort_order: neighborOrder }).first();
    if (!neighbor) return; // already at the edge — no-op

    await trx('checklist_steps').where({ id: step.id }).update({ sort_order: neighborOrder });
    await trx('checklist_steps').where({ id: neighbor.id }).update({ sort_order: step.sort_order });

    await logAudit(
      {
        userId: actor.id,
        action: 'TEMPLATE_STEP_CHANGED',
        entityType: 'checklist_template_version',
        entityId: versionId,
        newValue: { op: 'move', stepId, direction },
        ...meta,
      },
      trx,
    );
  });

  return getTemplate(templateId);
}

/**
 * DRAFT → PUBLISHED. The previously published version of the same template is
 * automatically ARCHIVED (§41: one "current active version" per template).
 */
export async function publishVersion(
  actor: AuthUser,
  templateId: number,
  versionId: number,
  meta: RequestMeta,
): Promise<TemplateDetail> {
  await db.transaction(async (trx) => {
    // Lock the TEMPLATE row first — a consistent lock order (template row → version
    // rows) shared with createVersion / archiveVersion / deleteTemplate, so
    // concurrent template mutations serialize on the template row and can never
    // deadlock on version-lock ordering (delete locks the version set in PK order;
    // publish would otherwise lock target-then-previous — the opposite order).
    const template = await trx('checklist_templates').where({ id: templateId }).forUpdate().first();
    if (!template) throw ApiError.notFound('Shablon topilmadi');

    const version = await trx('checklist_template_versions')
      .where({ id: versionId, template_id: templateId })
      .forUpdate()
      .first();
    if (!version) throw ApiError.notFound('Versiya topilmadi');
    if (version.status !== 'DRAFT') {
      throw ApiError.conflict('Faqat qoralama versiyani nashr qilish mumkin', 'VERSION_NOT_DRAFT');
    }

    const stepCount = (await trx('checklist_steps').where({ version_id: versionId }).count({ c: '*' })) as any;
    if (Number(stepCount[0].c) === 0) {
      throw ApiError.conflict("Bo'sh versiyani nashr qilib bo'lmaydi — avval bosqich qo'shing", 'EMPTY_VERSION');
    }

    const previous = await trx('checklist_template_versions')
      .where({ template_id: templateId, status: 'PUBLISHED' })
      .forUpdate()
      .first();
    if (previous) {
      await trx('checklist_template_versions')
        .where({ id: previous.id })
        .update({ status: 'ARCHIVED', updated_at: trx.fn.now() });
      await logAudit(
        {
          userId: actor.id,
          action: 'TEMPLATE_VERSION_ARCHIVED',
          entityType: 'checklist_template_version',
          entityId: previous.id,
          oldValue: { status: 'PUBLISHED' },
          newValue: { status: 'ARCHIVED', supersededBy: versionId },
          ...meta,
        },
        trx,
      );
    }

    await trx('checklist_template_versions')
      .where({ id: versionId })
      .update({ status: 'PUBLISHED', published_at: trx.fn.now(), updated_at: trx.fn.now() });

    await logAudit(
      {
        userId: actor.id,
        action: 'TEMPLATE_VERSION_PUBLISHED',
        entityType: 'checklist_template_version',
        entityId: versionId,
        oldValue: { status: 'DRAFT' },
        newValue: { status: 'PUBLISHED', version: version.version },
        ...meta,
      },
      trx,
    );
  });

  return getTemplate(templateId);
}

/** PUBLISHED → ARCHIVED (retire a template without a replacement). */
export async function archiveVersion(
  actor: AuthUser,
  templateId: number,
  versionId: number,
  meta: RequestMeta,
): Promise<TemplateDetail> {
  await db.transaction(async (trx) => {
    // Template row first — consistent lock order (see publishVersion/deleteTemplate).
    const template = await trx('checklist_templates').where({ id: templateId }).forUpdate().first();
    if (!template) throw ApiError.notFound('Shablon topilmadi');

    const version = await trx('checklist_template_versions')
      .where({ id: versionId, template_id: templateId })
      .forUpdate()
      .first();
    if (!version) throw ApiError.notFound('Versiya topilmadi');
    if (version.status !== 'PUBLISHED') {
      throw ApiError.conflict('Faqat nashr qilingan versiyani arxivlash mumkin', 'VERSION_NOT_PUBLISHED');
    }

    await trx('checklist_template_versions')
      .where({ id: versionId })
      .update({ status: 'ARCHIVED', updated_at: trx.fn.now() });

    await logAudit(
      {
        userId: actor.id,
        action: 'TEMPLATE_VERSION_ARCHIVED',
        entityType: 'checklist_template_version',
        entityId: versionId,
        oldValue: { status: 'PUBLISHED' },
        newValue: { status: 'ARCHIVED' },
        ...meta,
      },
      trx,
    );
  });

  return getTemplate(templateId);
}

/**
 * §D permanently delete an UNUSED, DRAFT-only template.
 *
 * Eligibility is re-checked HERE inside the transaction (the list's `deletable`
 * flag is only advisory), under a consistent lock order so a check-then-delete
 * race cannot slip a publish/assignment in between:
 *   1. lock the template row FOR UPDATE (serializes with createVersion + other deletes);
 *   2. lock ALL its version rows FOR UPDATE (serializes with publishVersion/archiveVersion —
 *      a concurrent publish either lands first, so we see PUBLISHED and refuse, or blocks
 *      and then 404s on the now-deleted version);
 *   3. refuse unless EVERY version is still DRAFT (a published/archived version is history
 *      that must be preserved via the version-archive lifecycle, never destroyed);
 *   4. defensively refuse if any job checklist/step still references it (a DRAFT-only
 *      template can never have been assigned, but we assert it rather than trust the FK);
 *   5. delete children→parent (steps [measurements cascade] → versions → template).
 * The DB foreign keys are RESTRICT throughout, so they are the last-line backstop — the
 * checks above turn a raw FK error into a stable business conflict. The audit records the
 * template name + version count only (no step internals).
 */
export async function deleteTemplate(
  actor: AuthUser,
  templateId: number,
  meta: RequestMeta,
): Promise<{ id: number; name: string }> {
  return db.transaction(async (trx) => {
    const template = await trx('checklist_templates').where({ id: templateId }).forUpdate().first();
    if (!template) throw ApiError.notFound('Shablon topilmadi');

    const versions = (await trx('checklist_template_versions')
      .where({ template_id: templateId })
      .forUpdate()) as { id: number; status: VersionStatus }[];

    if (versions.some((v) => v.status !== 'DRAFT')) {
      throw ApiError.conflict(
        "Nashr qilingan yoki arxivlangan versiyaga ega shablonni o'chirib bo'lmaydi — tarixni saqlash uchun uni arxivlang",
        'TEMPLATE_HAS_HISTORY',
      );
    }

    const versionIds = versions.map((v) => v.id);
    const stepIds = versionIds.length
      ? ((await trx('checklist_steps').whereIn('version_id', versionIds).select('id')) as { id: number }[]).map((s) => s.id)
      : [];

    // Defensive: a DRAFT-only template cannot have been assigned, but assert it so a
    // stray reference becomes a clear business conflict rather than a raw FK error.
    if (versionIds.length) {
      const jc = (await trx('job_checklists').whereIn('version_id', versionIds).count({ c: '*' }).first()) as
        | { c: number | string }
        | undefined;
      if (Number(jc?.c ?? 0) > 0) {
        throw ApiError.conflict("Bu shablon ishlarga biriktirilgan — uni o'chirib bo'lmaydi", 'TEMPLATE_IN_USE');
      }
    }
    if (stepIds.length) {
      const js = (await trx('job_steps').whereIn('step_id', stepIds).count({ c: '*' }).first()) as
        | { c: number | string }
        | undefined;
      if (Number(js?.c ?? 0) > 0) {
        throw ApiError.conflict("Bu shablon ishlarga biriktirilgan — uni o'chirib bo'lmaydi", 'TEMPLATE_IN_USE');
      }
    }

    // Children → parent. Measurements cascade when their step is deleted.
    if (stepIds.length) await trx('checklist_steps').whereIn('id', stepIds).del();
    if (versionIds.length) await trx('checklist_template_versions').whereIn('id', versionIds).del();
    await trx('checklist_templates').where({ id: templateId }).del();

    await logAudit(
      {
        userId: actor.id,
        action: 'TEMPLATE_DELETED',
        entityType: 'checklist_template',
        entityId: templateId,
        // Name + counts only — no step/measurement internals.
        oldValue: { name: template.name, versionsDeleted: versions.length },
        ...meta,
      },
      trx,
    );

    return { id: templateId, name: template.name as string };
  });
}
