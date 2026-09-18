import { RuleError } from '../errors.ts';
import type { FiscalModel } from './types.ts';

/**
 * Gera o próximo número sequencial de documento fiscal de forma estritamente atômica e
 * transacional no banco (§18, §75).
 * A numeração é única por (tenant, loja, modelo, série).
 * A instrução INSERT ... ON CONFLICT DO UPDATE SET current_number = current_number + 1 RETURNING
 * garante que mesmo sob concorrência nenhuma numeração será repetida ou pulada.
 */
export async function getNextFiscalNumber(
    db: D1Database,
    tenantId: string,
    storeId: string,
    model: FiscalModel,
    series: number,
    now = Date.now(),
): Promise<number> {
    const row = await db
        .prepare(
            `INSERT INTO fiscal_sequences (id, tenant_id, store_id, model, series, current_number, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?)
             ON CONFLICT(tenant_id, store_id, model, series)
             DO UPDATE SET current_number = fiscal_sequences.current_number + 1, updated_at = excluded.updated_at
             RETURNING current_number`,
        )
        .bind(crypto.randomUUID(), tenantId, storeId, model, series, now)
        .first<{ current_number: number }>();

    if (!row || typeof row.current_number !== 'number') {
        throw new RuleError('Falha ao obter número sequencial fiscal atômico.', 500);
    }

    return row.current_number;
}

/**
 * Consulta a numeração corrente de uma série sem incrementá-la.
 */
export async function getCurrentFiscalSequence(
    db: D1Database,
    tenantId: string,
    storeId: string,
    model: FiscalModel,
    series: number,
): Promise<number> {
    const row = await db
        .prepare(
            `SELECT current_number AS currentNumber FROM fiscal_sequences WHERE tenant_id = ? AND store_id = ? AND model = ? AND series = ?`,
        )
        .bind(tenantId, storeId, model, series)
        .first<{ currentNumber: number }>();

    return row?.currentNumber ?? 0;
}
