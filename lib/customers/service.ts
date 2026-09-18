import { z } from 'zod';
import { RuleError } from '../errors.ts';
import { requirePermission } from '../authz/service.ts';
import type { Actor } from '../domain.ts';

export type CustomerRecord = {
    id: string;
    tenantId: string;
    name: string;
    document: string;
    docType: 'CPF' | 'CNPJ';
    ie: string;
    indIeDest: '1' | '2' | '9';
    email: string;
    phone: string;
    zip: string;
    address: string;
    number: string;
    complement: string;
    district: string;
    city: string;
    state: string;
    municipalityCode: string;
    createdAt: number;
    updatedAt: number;
};

export type SupplierRecord = {
    id: string;
    tenantId: string;
    name: string;
    tradeName: string;
    document: string;
    docType: 'CNPJ' | 'CPF';
    ie: string;
    email: string;
    phone: string;
    contactName: string;
    zip: string;
    address: string;
    number: string;
    complement: string;
    district: string;
    city: string;
    state: string;
    municipalityCode: string;
    createdAt: number;
    updatedAt: number;
};

const shortText = z.string().trim().max(160);
const cleanDigits = (val: unknown) => typeof val === 'string' ? val.replace(/\D/g, '') : val;
const cleanUpper = (val: unknown) => typeof val === 'string' ? val.trim().toUpperCase() : val;

export const customerInputSchema = z.object({
    name: shortText.min(2, 'Nome deve ter pelo menos 2 caracteres.'),
    document: z.preprocess(cleanDigits, z.string().regex(/^(\d{11}|\d{14})?$/, 'Documento deve ser CPF (11 dígitos) ou CNPJ (14 dígitos).').default('')),
    docType: z.enum(['CPF', 'CNPJ']).default('CPF'),
    ie: shortText.default(''),
    indIeDest: z.enum(['1', '2', '9']).default('9'),
    email: z.string().trim().max(160).email('E-mail inválido.').or(z.literal('')).default(''),
    phone: shortText.default(''),
    zip: z.preprocess(cleanDigits, z.string().regex(/^(\d{8})?$/, 'CEP deve ter 8 dígitos numéricos.').default('')),
    address: shortText.default(''),
    number: shortText.default(''),
    complement: shortText.default(''),
    district: shortText.default(''),
    city: shortText.default(''),
    state: z.preprocess(cleanUpper, z.string().regex(/^([A-Z]{2})?$/, 'UF deve ter 2 letras maiúsculas.').default('')),
    municipalityCode: z.preprocess(cleanDigits, z.string().regex(/^(\d{7})?$/, 'Código IBGE do município deve ter 7 dígitos.').default('')),
}).strict();

export type CustomerInput = z.infer<typeof customerInputSchema>;
export const customerUpdateInputSchema = customerInputSchema.partial();
export type CustomerUpdateInput = z.infer<typeof customerUpdateInputSchema>;

export const supplierInputSchema = z.object({
    name: shortText.min(2, 'Razão Social / Nome deve ter pelo menos 2 caracteres.'),
    tradeName: shortText.default(''),
    document: z.preprocess(cleanDigits, z.string().regex(/^(\d{11}|\d{14})$/, 'Documento deve ser CNPJ (14 dígitos) ou CPF (11 dígitos).')),
    docType: z.enum(['CNPJ', 'CPF']).default('CNPJ'),
    ie: shortText.default(''),
    email: z.string().trim().max(160).email('E-mail inválido.').or(z.literal('')).default(''),
    phone: shortText.default(''),
    contactName: shortText.default(''),
    zip: z.preprocess(cleanDigits, z.string().regex(/^(\d{8})?$/, 'CEP deve ter 8 dígitos numéricos.').default('')),
    address: shortText.default(''),
    number: shortText.default(''),
    complement: shortText.default(''),
    district: shortText.default(''),
    city: shortText.default(''),
    state: z.preprocess(cleanUpper, z.string().regex(/^([A-Z]{2})?$/, 'UF deve ter 2 letras maiúsculas.').default('')),
    municipalityCode: z.preprocess(cleanDigits, z.string().regex(/^(\d{7})?$/, 'Código IBGE do município deve ter 7 dígitos.').default('')),
}).strict();

export type SupplierInput = z.infer<typeof supplierInputSchema>;
export const supplierUpdateInputSchema = supplierInputSchema.partial();
export type SupplierUpdateInput = z.infer<typeof supplierUpdateInputSchema>;

export async function listCustomers(
    db: D1Database,
    tenantId: string,
    actor: Actor,
    query?: string,
): Promise<CustomerRecord[]> {
    requirePermission(actor.permissions, 'CUSTOMER_VIEW');
    let sql = `SELECT id, tenant_id AS tenantId, name, document, doc_type AS docType, ie, ind_ie_dest AS indIeDest,
                      email, phone, zip, address, number, complement, district, city, state,
                      municipality_code AS municipalityCode, created_at AS createdAt, updated_at AS updatedAt
               FROM customers WHERE tenant_id = ?`;
    const params: unknown[] = [tenantId];

    if (query && query.trim()) {
        sql += ` AND (name LIKE ? OR document LIKE ? OR phone LIKE ? OR email LIKE ?)`;
        const q = `%${query.trim()}%`;
        params.push(q, q, q, q);
    }
    sql += ` ORDER BY name ASC LIMIT 100`;

    const rows = await db.prepare(sql).bind(...params).all<CustomerRecord>();
    return rows.results ?? [];
}

export async function getCustomer(
    db: D1Database,
    tenantId: string,
    id: string,
    actor: Actor,
): Promise<CustomerRecord | null> {
    requirePermission(actor.permissions, 'CUSTOMER_VIEW');
    return db
        .prepare(
            `SELECT id, tenant_id AS tenantId, name, document, doc_type AS docType, ie, ind_ie_dest AS indIeDest,
                    email, phone, zip, address, number, complement, district, city, state,
                    municipality_code AS municipalityCode, created_at AS createdAt, updated_at AS updatedAt
             FROM customers WHERE id = ? AND tenant_id = ?`,
        )
        .bind(id, tenantId)
        .first<CustomerRecord>();
}

export async function createCustomer(
    db: D1Database,
    tenantId: string,
    rawInput: unknown,
    actor: Actor,
    now = Date.now(),
): Promise<string> {
    requirePermission(actor.permissions, 'CUSTOMER_CREATE');
    const input = customerInputSchema.parse(rawInput);
    const id = crypto.randomUUID();

    const cleanDoc = input.document.replace(/\D/g, '');
    const docType = cleanDoc.length === 14 ? 'CNPJ' : 'CPF';

    if (cleanDoc) {
        const existing = await db
            .prepare(`SELECT id FROM customers WHERE tenant_id = ? AND document = ?`)
            .bind(tenantId, cleanDoc)
            .first<{ id: string }>();
        if (existing) {
            throw new RuleError(`Já existe um cliente cadastrado com este documento (${cleanDoc}).`, 409);
        }
    }

    await db
        .prepare(
            `INSERT INTO customers
             (id, tenant_id, name, document, doc_type, ie, ind_ie_dest, email, phone, zip, address, number, complement, district, city, state, municipality_code, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
            id,
            tenantId,
            input.name,
            cleanDoc,
            docType,
            input.ie,
            input.indIeDest,
            input.email,
            input.phone,
            input.zip.replace(/\D/g, ''),
            input.address,
            input.number,
            input.complement,
            input.district,
            input.city,
            input.state.toUpperCase(),
            input.municipalityCode.replace(/\D/g, ''),
            now,
            now,
        )
        .run();

    return id;
}

export async function updateCustomer(
    db: D1Database,
    tenantId: string,
    id: string,
    rawInput: unknown,
    actor: Actor,
    now = Date.now(),
): Promise<string> {
    requirePermission(actor.permissions, 'CUSTOMER_EDIT');
    const existing = await getCustomer(db, tenantId, id, actor);
    if (!existing) {
        throw new RuleError('Cliente não encontrado.', 404);
    }
    const input = customerUpdateInputSchema.parse(rawInput);

    const merged = {
        name: input.name ?? existing.name,
        document: input.document !== undefined ? (input.document ? input.document.replace(/\D/g, '') : '') : existing.document,
        docType: input.docType ?? existing.docType,
        ie: input.ie ?? existing.ie,
        indIeDest: input.indIeDest ?? existing.indIeDest,
        email: input.email ?? existing.email,
        phone: input.phone ?? existing.phone,
        zip: input.zip !== undefined ? (input.zip ? input.zip.replace(/\D/g, '') : '') : existing.zip,
        address: input.address ?? existing.address,
        number: input.number ?? existing.number,
        complement: input.complement ?? existing.complement,
        district: input.district ?? existing.district,
        city: input.city ?? existing.city,
        state: input.state !== undefined ? (input.state ? input.state.toUpperCase() : '') : existing.state,
        municipalityCode: input.municipalityCode !== undefined ? (input.municipalityCode ? input.municipalityCode.replace(/\D/g, '') : '') : existing.municipalityCode,
    };

    const cleanDoc = merged.document;
    const docType = cleanDoc.length === 14 ? 'CNPJ' : 'CPF';

    if (cleanDoc) {
        const dup = await db
            .prepare(`SELECT id FROM customers WHERE tenant_id = ? AND document = ? AND id != ?`)
            .bind(tenantId, cleanDoc, id)
            .first<{ id: string }>();
        if (dup) {
            throw new RuleError(`Já existe outro cliente cadastrado com este documento (${cleanDoc}).`, 409);
        }
    }

    await db
        .prepare(
            `UPDATE customers SET
             name = ?, document = ?, doc_type = ?, ie = ?, ind_ie_dest = ?, email = ?, phone = ?,
             zip = ?, address = ?, number = ?, complement = ?, district = ?, city = ?, state = ?,
             municipality_code = ?, updated_at = ?
             WHERE id = ? AND tenant_id = ?`,
        )
        .bind(
            merged.name,
            cleanDoc,
            docType,
            merged.ie,
            merged.indIeDest,
            merged.email,
            merged.phone,
            merged.zip,
            merged.address,
            merged.number,
            merged.complement,
            merged.district,
            merged.city,
            merged.state,
            merged.municipalityCode,
            now,
            id,
            tenantId,
        )
        .run();

    return id;
}

export async function listSuppliers(
    db: D1Database,
    tenantId: string,
    actor: Actor,
    query?: string,
): Promise<SupplierRecord[]> {
    requirePermission(actor.permissions, 'SUPPLIER_VIEW');
    let sql = `SELECT id, tenant_id AS tenantId, name, trade_name AS tradeName, document, doc_type AS docType, ie,
                      email, phone, contact_name AS contactName, zip, address, number, complement, district, city, state,
                      municipality_code AS municipalityCode, created_at AS createdAt, updated_at AS updatedAt
               FROM suppliers WHERE tenant_id = ?`;
    const params: unknown[] = [tenantId];

    if (query && query.trim()) {
        sql += ` AND (name LIKE ? OR trade_name LIKE ? OR document LIKE ? OR phone LIKE ?)`;
        const q = `%${query.trim()}%`;
        params.push(q, q, q, q);
    }
    sql += ` ORDER BY name ASC LIMIT 100`;

    const rows = await db.prepare(sql).bind(...params).all<SupplierRecord>();
    return rows.results ?? [];
}

export async function getSupplier(
    db: D1Database,
    tenantId: string,
    id: string,
    actor: Actor,
): Promise<SupplierRecord | null> {
    requirePermission(actor.permissions, 'SUPPLIER_VIEW');
    return db
        .prepare(
            `SELECT id, tenant_id AS tenantId, name, trade_name AS tradeName, document, doc_type AS docType, ie,
                    email, phone, contact_name AS contactName, zip, address, number, complement, district, city, state,
                    municipality_code AS municipalityCode, created_at AS createdAt, updated_at AS updatedAt
             FROM suppliers WHERE id = ? AND tenant_id = ?`,
        )
        .bind(id, tenantId)
        .first<SupplierRecord>();
}

export async function createSupplier(
    db: D1Database,
    tenantId: string,
    rawInput: unknown,
    actor: Actor,
    now = Date.now(),
): Promise<string> {
    requirePermission(actor.permissions, 'SUPPLIER_CREATE');
    const input = supplierInputSchema.parse(rawInput);
    const id = crypto.randomUUID();

    const cleanDoc = input.document.replace(/\D/g, '');
    const docType = cleanDoc.length === 14 ? 'CNPJ' : 'CPF';

    const existing = await db
        .prepare(`SELECT id FROM suppliers WHERE tenant_id = ? AND document = ?`)
        .bind(tenantId, cleanDoc)
        .first<{ id: string }>();
    if (existing) {
        throw new RuleError(`Já existe um fornecedor cadastrado com este documento (${cleanDoc}).`, 409);
    }

    await db
        .prepare(
            `INSERT INTO suppliers
             (id, tenant_id, name, trade_name, document, doc_type, ie, email, phone, contact_name, zip, address, number, complement, district, city, state, municipality_code, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
            id,
            tenantId,
            input.name,
            input.tradeName,
            cleanDoc,
            docType,
            input.ie,
            input.email,
            input.phone,
            input.contactName,
            input.zip.replace(/\D/g, ''),
            input.address,
            input.number,
            input.complement,
            input.district,
            input.city,
            input.state.toUpperCase(),
            input.municipalityCode.replace(/\D/g, ''),
            now,
            now,
        )
        .run();

    return id;
}

export async function updateSupplier(
    db: D1Database,
    tenantId: string,
    id: string,
    rawInput: unknown,
    actor: Actor,
    now = Date.now(),
): Promise<string> {
    requirePermission(actor.permissions, 'SUPPLIER_EDIT');
    const existing = await getSupplier(db, tenantId, id, actor);
    if (!existing) {
        throw new RuleError('Fornecedor não encontrado.', 404);
    }
    const input = supplierUpdateInputSchema.parse(rawInput);

    const merged = {
        name: input.name ?? existing.name,
        tradeName: input.tradeName ?? existing.tradeName,
        document: input.document !== undefined ? (input.document ? input.document.replace(/\D/g, '') : '') : existing.document,
        docType: input.docType ?? existing.docType,
        ie: input.ie ?? existing.ie,
        email: input.email ?? existing.email,
        phone: input.phone ?? existing.phone,
        contactName: input.contactName ?? existing.contactName,
        zip: input.zip !== undefined ? (input.zip ? input.zip.replace(/\D/g, '') : '') : existing.zip,
        address: input.address ?? existing.address,
        number: input.number ?? existing.number,
        complement: input.complement ?? existing.complement,
        district: input.district ?? existing.district,
        city: input.city ?? existing.city,
        state: input.state !== undefined ? (input.state ? input.state.toUpperCase() : '') : existing.state,
        municipalityCode: input.municipalityCode !== undefined ? (input.municipalityCode ? input.municipalityCode.replace(/\D/g, '') : '') : existing.municipalityCode,
    };

    const cleanDoc = merged.document;
    const docType = cleanDoc.length === 14 ? 'CNPJ' : 'CPF';

    const dup = await db
        .prepare(`SELECT id FROM suppliers WHERE tenant_id = ? AND document = ? AND id != ?`)
        .bind(tenantId, cleanDoc, id)
        .first<{ id: string }>();
    if (dup) {
        throw new RuleError(`Já existe outro fornecedor cadastrado com este documento (${cleanDoc}).`, 409);
    }

    await db
        .prepare(
            `UPDATE suppliers SET
             name = ?, trade_name = ?, document = ?, doc_type = ?, ie = ?, email = ?, phone = ?,
             contact_name = ?, zip = ?, address = ?, number = ?, complement = ?, district = ?, city = ?, state = ?,
             municipality_code = ?, updated_at = ?
             WHERE id = ? AND tenant_id = ?`,
        )
        .bind(
            merged.name,
            merged.tradeName,
            cleanDoc,
            docType,
            merged.ie,
            merged.email,
            merged.phone,
            merged.contactName,
            merged.zip,
            merged.address,
            merged.number,
            merged.complement,
            merged.district,
            merged.city,
            merged.state,
            merged.municipalityCode,
            now,
            id,
            tenantId,
        )
        .run();

    return id;
}
