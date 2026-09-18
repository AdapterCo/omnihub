import { RuleError } from '../errors.ts';
import { requirePermission, requireStoreAccess } from '../authz/service.ts';
import type { PermissionCode } from '../authz/permissions.ts';
import { storeFields, productFields } from '../domain.ts';

// Catálogo relacional (instrucoes.md §3, §8). Fase 2: ainda NÃO é consumido pelo PDV
// (que continua operando sobre o JSON via lib/domain.ts) — ver nota em db/schema.ts.
// Reaproveita os schemas Zod já existentes em lib/domain.ts (mesma validação de campos).

type Actor = { userId: string; storeId?: string | null; role?: string; permissions: ReadonlySet<PermissionCode> };

export type StoreRow = {
 id: string; tenantId: string; name: string; legalName: string; cnpj: string; ie: string; regime: string;
 uf: string; city: string; municipalityCode: string; address: string; number: string; district: string; zip: string; createdAt: number;
};

export async function createStore(db: D1Database, tenantId: string, input: unknown, actor: Actor, now = Date.now()): Promise<string> {
 requirePermission(actor.permissions, 'STORE_CREATE');
 const data = storeFields.parse(input);
 const id = crypto.randomUUID();
 await db
  .prepare('INSERT INTO stores (id, tenant_id, name, legal_name, cnpj, ie, regime, uf, city, municipality_code, address, number, district, zip, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .bind(id, tenantId, data.name, data.legalName, data.cnpj, data.ie, data.regime, data.uf, data.city, data.municipalityCode, data.address, data.number, data.district, data.zip, now)
  .run();
 return id;
}

export async function updateStore(db: D1Database, tenantId: string, id: string, input: unknown, actor: Actor): Promise<void> {
 requirePermission(actor.permissions, 'STORE_EDIT');
 requireStoreAccess(actor, id);
 const data = storeFields.parse(input);
 const result = await db
  .prepare('UPDATE stores SET name=?, legal_name=?, cnpj=?, ie=?, regime=?, uf=?, city=?, municipality_code=?, address=?, number=?, district=?, zip=? WHERE id=? AND tenant_id=?')
  .bind(data.name, data.legalName, data.cnpj, data.ie, data.regime, data.uf, data.city, data.municipalityCode, data.address, data.number, data.district, data.zip, id, tenantId)
  .run();
 if (result.meta.changes !== 1) throw new RuleError('Loja não encontrada.', 404);
}

export async function listStores(db: D1Database, tenantId: string): Promise<StoreRow[]> {
 const rows = await db
  .prepare('SELECT id, tenant_id AS tenantId, name, legal_name AS legalName, cnpj, ie, regime, uf, city, municipality_code AS municipalityCode, address, number, district, zip, created_at AS createdAt FROM stores WHERE tenant_id = ? ORDER BY created_at')
  .bind(tenantId)
  .all<StoreRow>();
 return rows.results ?? [];
}

export async function getStore(db: D1Database, tenantId: string, id: string): Promise<StoreRow | null> {
 return db
  .prepare('SELECT id, tenant_id AS tenantId, name, legal_name AS legalName, cnpj, ie, regime, uf, city, municipality_code AS municipalityCode, address, number, district, zip, created_at AS createdAt FROM stores WHERE id = ? AND tenant_id = ?')
  .bind(id, tenantId)
  .first<StoreRow>();
}

export async function countStores(db: D1Database, tenantId: string): Promise<number> {
 const row = await db.prepare('SELECT COUNT(*) AS n FROM stores WHERE tenant_id = ?').bind(tenantId).first<{ n: number }>();
 return row?.n ?? 0;
}

export type ProductRow = {
 id: string; tenantId: string; sku: string; barcode: string; name: string; unit: string; costPrice: number; salePrice: number; minStock: number; active: number;
};

export async function createProduct(db: D1Database, tenantId: string, input: unknown, actor: Actor, now = Date.now()): Promise<string> {
 requirePermission(actor.permissions, 'PRODUCT_CREATE');
 const data = productFields.parse(input);
 const dupe = await db.prepare('SELECT id FROM products WHERE tenant_id = ? AND sku = ?').bind(tenantId, data.sku).first<{ id: string }>();
 if (dupe) throw new RuleError('Já existe um produto com este SKU.', 409);
 const id = crypto.randomUUID();
 await db.prepare('INSERT INTO products (id, tenant_id, sku, barcode, name, unit, cost_price, sale_price, min_stock, active, created_at) VALUES (?,?,?,?,?,?,?,?,?,1,?)')
  .bind(id, tenantId, data.sku, data.barcode, data.name, data.unit, data.cost, data.price, data.minimum, now)
  .run();
 await db.prepare('INSERT INTO product_fiscal_profiles (id, product_id, ncm, cest, origin, tax_code, legacy_cfop) VALUES (?,?,?,?,?,?,?)')
  .bind(crypto.randomUUID(), id, data.ncm, data.cest, data.origin, data.taxCode, data.cfop)
  .run();
 return id;
}

export async function updateProduct(db: D1Database, tenantId: string, id: string, input: unknown, actor: Actor): Promise<void> {
 requirePermission(actor.permissions, 'PRODUCT_EDIT');
 const data = productFields.parse(input);
 const dupe = await db.prepare('SELECT id FROM products WHERE tenant_id = ? AND sku = ? AND id != ?').bind(tenantId, data.sku, id).first<{ id: string }>();
 if (dupe) throw new RuleError('Já existe um produto com este SKU.', 409);
 const result = await db.prepare('UPDATE products SET sku=?, barcode=?, name=?, unit=?, cost_price=?, sale_price=?, min_stock=? WHERE id=? AND tenant_id=?')
  .bind(data.sku, data.barcode, data.name, data.unit, data.cost, data.price, data.minimum, id, tenantId)
  .run();
 if (result.meta.changes !== 1) throw new RuleError('Produto não encontrado.', 404);
 await db.prepare('UPDATE product_fiscal_profiles SET ncm=?, cest=?, origin=?, tax_code=?, legacy_cfop=? WHERE product_id=?')
  .bind(data.ncm, data.cest, data.origin, data.taxCode, data.cfop, id)
  .run();
}

export async function listProducts(db: D1Database, tenantId: string): Promise<ProductRow[]> {
 const rows = await db
  .prepare('SELECT id, tenant_id AS tenantId, sku, barcode, name, unit, cost_price AS costPrice, sale_price AS salePrice, min_stock AS minStock, active FROM products WHERE tenant_id = ? ORDER BY created_at')
  .bind(tenantId)
  .all<ProductRow>();
 return rows.results ?? [];
}

/** Preço/nome mínimos para o motor de venda (lib/domain.ts). Não expõe custo nem fiscal. */
export async function getProductForSale(db: D1Database, tenantId: string, id: string): Promise<{ id: string; name: string; sku: string; price: number } | null> {
 return db.prepare('SELECT id, name, sku, sale_price AS price FROM products WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first<{ id: string; name: string; sku: string; price: number }>();
}

// Forma compatível com o antigo `Product` embutido no JSON (lib/domain.ts), usada apenas
// para montar a resposta da API sem alterar o contrato com o frontend durante o corte.
export type ProductSnapshotRow = {
 id: string; name: string; sku: string; barcode: string; price: number; cost: number; minimum: number; ncm: string; cest: string; cfop: string; origin: string; taxCode: string; unit: string;
};

export async function listProductsForSnapshot(db: D1Database, tenantId: string): Promise<ProductSnapshotRow[]> {
 const rows = await db
  .prepare(
   `SELECT p.id AS id, p.name AS name, p.sku AS sku, p.barcode AS barcode, p.sale_price AS price, p.cost_price AS cost, p.min_stock AS minimum, p.unit AS unit,
     f.ncm AS ncm, f.cest AS cest, f.legacy_cfop AS cfop, f.origin AS origin, f.tax_code AS taxCode
    FROM products p LEFT JOIN product_fiscal_profiles f ON f.product_id = p.id
    WHERE p.tenant_id = ? ORDER BY p.created_at`,
  )
  .bind(tenantId)
  .all<ProductSnapshotRow>();
 return (rows.results ?? []).map((row) => ({ ...row, ncm: row.ncm ?? '', cest: row.cest ?? '', cfop: row.cfop ?? '', origin: row.origin ?? '', taxCode: row.taxCode ?? '' }));
}
