import type { Knex } from 'knex';
import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import type { AuthUser } from '../../types/auth';
import type { CreateVehicleInput, ListVehiclesQuery, UpdateVehicleInput } from './vehicles.validators';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface VehicleDetail {
  id: number;
  customerId: number;
  customerName: string;
  customerPhone: string;
  plateNumber: string;
  vin: string | null;
  make: string;
  model: string;
  year: number | null;
  engine: string | null;
  mileage: number | null;
  createdAt: Date;
}

interface VehicleRow {
  id: number;
  customer_id: number;
  customer_name: string;
  customer_phone: string;
  plate_number: string;
  vin: string | null;
  make: string;
  model: string;
  year: number | null;
  engine: string | null;
  mileage: number | null;
  created_at: Date;
}

function toDetail(row: VehicleRow): VehicleDetail {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    plateNumber: row.plate_number,
    vin: row.vin,
    make: row.make,
    model: row.model,
    year: row.year,
    engine: row.engine,
    mileage: row.mileage,
    createdAt: row.created_at,
  };
}

const baseSelect = () =>
  db('vehicles')
    .select('vehicles.*', 'customers.name as customer_name', 'customers.phone as customer_phone')
    .join('customers', 'customers.id', 'vehicles.customer_id')
    .whereNull('vehicles.deleted_at');

export interface ListVehiclesResult {
  vehicles: VehicleDetail[];
  total: number;
  page: number;
  limit: number;
}

export async function listVehicles(query: ListVehiclesQuery): Promise<ListVehiclesResult> {
  const build = () => {
    const q = baseSelect();
    if (query.customerId) q.where('vehicles.customer_id', query.customerId);
    if (query.search) {
      const term = `%${query.search.replace(/[%_]/g, '\\$&')}%`;
      // Plates/VINs are stored normalized (uppercase, no spaces) — normalize
      // the search the same way so "01 a 123 bc" finds "01A123BC".
      const idTerm = `%${query.search.toUpperCase().replace(/[\s-]/g, '').replace(/[%_]/g, '\\$&')}%`;
      q.where((sub) => {
        sub
          .where('vehicles.plate_number', 'like', idTerm)
          .orWhere('vehicles.vin', 'like', idTerm)
          .orWhere('vehicles.make', 'like', term)
          .orWhere('vehicles.model', 'like', term);
      });
    }
    return q;
  };

  const countRows = (await build()
    .clearSelect()
    .count({ count: '*' })) as unknown as [{ count: number | string }];
  const total = Number(countRows[0]?.count ?? 0);

  const rows = (await build()
    .orderBy('vehicles.created_at', 'desc')
    .limit(query.limit)
    .offset((query.page - 1) * query.limit)) as VehicleRow[];

  return { vehicles: rows.map(toDetail), total, page: query.page, limit: query.limit };
}

/** Vehicles of one customer — the caller must have verified the customer exists. */
export async function listVehiclesOfCustomer(customerId: number): Promise<VehicleDetail[]> {
  const rows = (await baseSelect().where('vehicles.customer_id', customerId).orderBy('vehicles.created_at', 'desc')) as VehicleRow[];
  return rows.map(toDetail);
}

export async function getVehicle(id: number): Promise<VehicleDetail> {
  const row = (await baseSelect().where('vehicles.id', id).first()) as VehicleRow | undefined;
  if (!row) throw ApiError.notFound('Avtomobil topilmadi');
  return toDetail(row);
}

async function assertCustomerExists(customerId: number, trx?: Knex.Transaction): Promise<void> {
  const customer = await (trx ?? db)('customers').where({ id: customerId }).whereNull('deleted_at').first();
  if (!customer) throw ApiError.badRequest('Tanlangan mijoz mavjud emas', 'INVALID_CUSTOMER');
}

/** Global identity rules for the future §13 "existing vehicle" lookup. */
async function assertPlateAvailable(plate: string, excludeId?: number, trx?: Knex.Transaction): Promise<void> {
  const q = (trx ?? db)('vehicles').where({ plate_number: plate }).whereNull('deleted_at');
  if (excludeId !== undefined) q.whereNot({ id: excludeId });
  if (await q.first()) {
    throw ApiError.conflict('Bu davlat raqamli avtomobil allaqachon mavjud', 'PLATE_TAKEN');
  }
}

async function assertVinAvailable(vin: string, excludeId?: number, trx?: Knex.Transaction): Promise<void> {
  const q = (trx ?? db)('vehicles').where({ vin }).whereNull('deleted_at');
  if (excludeId !== undefined) q.whereNot({ id: excludeId });
  if (await q.first()) {
    throw ApiError.conflict('Bu VIN raqamli avtomobil allaqachon mavjud', 'VIN_TAKEN');
  }
}

export async function createVehicle(actor: AuthUser, input: CreateVehicleInput, meta: RequestMeta): Promise<VehicleDetail> {
  const id = await db.transaction(async (trx) => {
    await assertCustomerExists(input.customerId, trx);
    await assertPlateAvailable(input.plateNumber, undefined, trx);
    if (input.vin != null) await assertVinAvailable(input.vin, undefined, trx);

    const [newId] = await trx('vehicles').insert({
      customer_id: input.customerId,
      plate_number: input.plateNumber,
      vin: input.vin ?? null,
      make: input.make,
      model: input.model,
      year: input.year ?? null,
      engine: input.engine ?? null,
      mileage: input.mileage ?? null,
      created_by: actor.id,
    });

    await logAudit(
      {
        userId: actor.id,
        action: 'VEHICLE_CREATED',
        entityType: 'vehicle',
        entityId: newId,
        newValue: {
          customerId: input.customerId,
          plateNumber: input.plateNumber,
          vin: input.vin ?? null,
          make: input.make,
          model: input.model,
        },
        ...meta,
      },
      trx,
    );

    return newId as number;
  });

  return getVehicle(id);
}

export async function updateVehicle(
  actor: AuthUser,
  id: number,
  input: UpdateVehicleInput,
  meta: RequestMeta,
): Promise<VehicleDetail> {
  await db.transaction(async (trx) => {
    const current = (await trx('vehicles').where({ id }).whereNull('deleted_at').forUpdate().first()) as
      | Omit<VehicleRow, 'customer_name' | 'customer_phone'>
      | undefined;
    if (!current) throw ApiError.notFound('Avtomobil topilmadi');

    if (input.customerId !== undefined && input.customerId !== current.customer_id) {
      await assertCustomerExists(input.customerId, trx);
    }
    if (input.plateNumber !== undefined && input.plateNumber !== current.plate_number) {
      await assertPlateAvailable(input.plateNumber, id, trx);
    }
    if (input.vin != null && input.vin !== current.vin) {
      await assertVinAvailable(input.vin, id, trx);
    }

    const fieldMap = {
      customerId: 'customer_id',
      plateNumber: 'plate_number',
      vin: 'vin',
      make: 'make',
      model: 'model',
      year: 'year',
      engine: 'engine',
      mileage: 'mileage',
    } as const;

    const update: Record<string, unknown> = { updated_at: trx.fn.now() };
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    for (const [inputKey, column] of Object.entries(fieldMap) as [keyof typeof fieldMap, string][]) {
      const next = input[inputKey];
      const currentValue = (current as Record<string, unknown>)[column];
      if (next !== undefined && next !== currentValue) {
        update[column] = next;
        changes[inputKey] = { old: currentValue, new: next };
      }
    }

    if (Object.keys(changes).length > 0) {
      await trx('vehicles').where({ id }).update(update);
      await logAudit(
        {
          userId: actor.id,
          action: 'VEHICLE_UPDATED',
          entityType: 'vehicle',
          entityId: id,
          newValue: changes,
          ...meta,
        },
        trx,
      );
    }
  });

  return getVehicle(id);
}
