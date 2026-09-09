/**
 * Registry of the simple reference-data kinds (name-based, plus units which also
 * carry a code). Each entry declares its table, its Uzbek label for messages, its
 * audit entity_type, whether it has a `code`, and every column in other tables
 * that references it — used to protect referenced rows from hard deletion (an
 * eligibility check re-run transactionally, backed by the DB FK RESTRICT).
 *
 * Engine injection reference is NOT here — it has a distinct shape (technology /
 * forced-induction) and lives in its own module. Service centres are the existing
 * `branches` table and are managed by the branches module — no duplicate here.
 */
export interface ReferenceKindConfig {
  table: string;
  label: string;
  entityType: string;
  hasCode: boolean;
  references: { table: string; column: string; label: string }[];
}

export const REFERENCE_KINDS = {
  companies: {
    table: 'catalog_companies',
    label: 'Kompaniya',
    entityType: 'catalog_company',
    hasCode: false,
    references: [{ table: 'products', column: 'company_id', label: 'mahsulot' }],
  },
  brands: {
    table: 'catalog_brands',
    label: 'Brend',
    entityType: 'catalog_brand',
    hasCode: false,
    references: [{ table: 'products', column: 'brand_id', label: 'mahsulot' }],
  },
  'product-categories': {
    table: 'product_categories',
    label: 'Mahsulot kategoriyasi',
    entityType: 'product_category',
    hasCode: false,
    references: [{ table: 'products', column: 'category_id', label: 'mahsulot' }],
  },
  'service-categories': {
    table: 'service_categories',
    label: 'Xizmat kategoriyasi',
    entityType: 'service_category',
    hasCode: false,
    references: [{ table: 'services', column: 'category_id', label: 'xizmat' }],
  },
  units: {
    table: 'catalog_units',
    label: "O'lchov birligi",
    entityType: 'catalog_unit',
    hasCode: true,
    references: [{ table: 'products', column: 'unit_id', label: 'mahsulot' }],
  },
} as const satisfies Record<string, ReferenceKindConfig>;

export type ReferenceKind = keyof typeof REFERENCE_KINDS;

export function isReferenceKind(value: string): value is ReferenceKind {
  return Object.prototype.hasOwnProperty.call(REFERENCE_KINDS, value);
}
