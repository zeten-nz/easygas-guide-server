import { db } from '../../config/database';
import { ApiError } from '../../utils/errors';
import { logAudit } from '../audit/audit.service';
import type { AuthUser } from '../../types/auth';
import type { CreateCustomerInput, ListCustomersQuery, UpdateCustomerInput } from './customers.validators';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface CustomerDetail {
  id: number;
  name: string;
  phone: string;
  vehicleCount: number;
  createdAt: Date;
}

interface CustomerRow {
  id: number;
  name: string;
  phone: string;
  vehicle_count?: number | string;
  created_at: Date;
}

function toDetail(row: CustomerRow): CustomerDetail {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    vehicleCount: Number(row.vehicle_count ?? 0),
    createdAt: row.created_at,
  };
}

const baseSelect = () =>
  db('customers')
    .select('customers.*')
    .count({ vehicle_count: 'vehicles.id' })
    .leftJoin('vehicles', function join() {
      this.on('vehicles.customer_id', 'customers.id').andOnNull('vehicles.deleted_at');
    })
    .whereNull('customers.deleted_at')
    .groupBy('customers.id');

export interface ListCustomersResult {
  customers: CustomerDetail[];
  total: number;
  page: number;
  limit: number;
}

export async function listCustomers(query: ListCustomersQuery): Promise<ListCustomersResult> {
  // Applied to both the count and the page query.
  // Plain LIKE (not whereILike) — see the utf8mb4 COLLATE note in users.service.
  const searchFilter = (q: { where: (cb: (sub: never) => void) => unknown }) => {
    if (!query.search) return;
    const term = `%${query.search.replace(/[%_]/g, '\\$&')}%`;
    const phoneDigits = query.search.replace(/\D/g, '');
    q.where((sub: any) => {
      sub.where('customers.name', 'like', term);
      if (phoneDigits.length >= 4) sub.orWhere('customers.phone', 'like', `%${phoneDigits}%`);
    });
  };

  const countQuery = db('customers').whereNull('deleted_at');
  searchFilter(countQuery as never);
  const countRows = (await countQuery.count({ count: '*' })) as unknown as [{ count: number | string }];
  const total = Number(countRows[0]?.count ?? 0);

  const pageQuery = baseSelect();
  searchFilter(pageQuery as never);
  const rows = (await pageQuery
    .orderBy('customers.created_at', 'desc')
    .limit(query.limit)
    .offset((query.page - 1) * query.limit)) as unknown as CustomerRow[];

  return { customers: rows.map(toDetail), total, page: query.page, limit: query.limit };
}

export async function getCustomer(id: number): Promise<CustomerDetail> {
  const row = (await baseSelect().where('customers.id', id).first()) as CustomerRow | undefined;
  if (!row) throw ApiError.notFound('Mijoz topilmadi');
  return toDetail(row);
}

export async function createCustomer(
  actor: AuthUser,
  input: CreateCustomerInput,
  meta: RequestMeta,
): Promise<CustomerDetail> {
  const id = await db.transaction(async (trx) => {
    const [newId] = await trx('customers').insert({
      name: input.name,
      phone: input.phone,
      created_by: actor.id,
    });
    await logAudit(
      {
        userId: actor.id,
        action: 'CUSTOMER_CREATED',
        entityType: 'customer',
        entityId: newId,
        newValue: { name: input.name, phone: input.phone },
        ...meta,
      },
      trx,
    );
    return newId as number;
  });

  return getCustomer(id);
}

export async function updateCustomer(
  actor: AuthUser,
  id: number,
  input: UpdateCustomerInput,
  meta: RequestMeta,
): Promise<CustomerDetail> {
  await db.transaction(async (trx) => {
    const current = (await trx('customers').where({ id }).whereNull('deleted_at').forUpdate().first()) as
      | { name: string; phone: string }
      | undefined;
    if (!current) throw ApiError.notFound('Mijoz topilmadi');

    const update: Record<string, unknown> = { updated_at: trx.fn.now() };
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    for (const field of ['name', 'phone'] as const) {
      const next = input[field];
      if (next !== undefined && next !== current[field]) {
        update[field] = next;
        changes[field] = { old: current[field], new: next };
      }
    }

    if (Object.keys(changes).length > 0) {
      await trx('customers').where({ id }).update(update);
      await logAudit(
        {
          userId: actor.id,
          action: 'CUSTOMER_UPDATED',
          entityType: 'customer',
          entityId: id,
          newValue: changes,
          ...meta,
        },
        trx,
      );
    }
  });

  return getCustomer(id);
}
