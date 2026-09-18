import { requirePermission } from '../authz/service.ts';
import type { Actor } from '../domain.ts';

// Fase 8 (§75: "relatórios"). Todos os relatórios são agregações somente-leitura sobre
// dados já persistidos (sales/sale_payments/cash_sessions/cash_movements/
// fiscal_documents) — nenhum número aqui é calculado por regra de negócio nova ou
// presumido; é soma/contagem do que já foi registrado pelas fases anteriores.

export type SalesReportInput = { storeId?: string; from?: number; to?: number };

export type SalesReportPeriod = { day: string; storeId: string; storeName: string; count: number; total: number };
export type SalesReportPayment = { method: string; amount: number };
export type SalesReport = {
    periods: SalesReportPeriod[];
    payments: SalesReportPayment[];
    totals: { count: number; total: number; avgTicket: number; cancelledCount: number };
};

export async function getSalesReport(db: D1Database, tenantId: string, actor: Actor, input: SalesReportInput = {}): Promise<SalesReport> {
    requirePermission(actor.permissions, 'REPORT_VIEW');

    const from = input.from ?? 0;
    const to = input.to ?? Date.now();
    const storeFilter = input.storeId ? ' AND s.store_id = ?' : '';
    const storeArgs = input.storeId ? [input.storeId] : [];

    const periodsRows = await db
        .prepare(
            `SELECT s.store_id AS storeId, s.store_name AS storeName,
                    strftime('%Y-%m-%d', s.created_at / 1000, 'unixepoch') AS day,
                    COUNT(*) AS count, SUM(s.total) AS total
             FROM sales s
             WHERE s.tenant_id = ? AND s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ?${storeFilter}
             GROUP BY s.store_id, day
             ORDER BY day DESC`,
        )
        .bind(tenantId, from, to, ...storeArgs)
        .all<{ storeId: string; storeName: string; day: string; count: number; total: number }>();

    const paymentsRows = await db
        .prepare(
            `SELECT sp.method AS method, SUM(sp.amount) AS amount
             FROM sale_payments sp
             JOIN sales s ON s.id = sp.sale_id
             WHERE s.tenant_id = ? AND s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ?${storeFilter}
             GROUP BY sp.method
             ORDER BY amount DESC`,
        )
        .bind(tenantId, from, to, ...storeArgs)
        .all<{ method: string; amount: number }>();

    const cancelledRow = await db
        .prepare(`SELECT COUNT(*) AS count FROM sales s WHERE s.tenant_id = ? AND s.status = 'CANCELLED' AND s.created_at BETWEEN ? AND ?${storeFilter}`)
        .bind(tenantId, from, to, ...storeArgs)
        .first<{ count: number }>();

    const periods = periodsRows.results ?? [];
    const totalCount = periods.reduce((a, p) => a + p.count, 0);
    const totalAmount = periods.reduce((a, p) => a + p.total, 0);

    return {
        periods,
        payments: paymentsRows.results ?? [],
        totals: {
            count: totalCount,
            total: totalAmount,
            avgTicket: totalCount > 0 ? Math.round(totalAmount / totalCount) : 0,
            cancelledCount: cancelledRow?.count ?? 0,
        },
    };
}

export type CashReportInput = { storeId?: string };

export type CashReportSession = {
    id: string;
    storeId: string;
    storeName: string;
    operator: string;
    openedAt: number;
    closedAt: number | null;
    opening: number;
    counted: number | null;
    expected: number | null;
    difference: number | null;
    supplies: number;
    withdrawals: number;
};

export type CashReport = {
    sessions: CashReportSession[];
    totals: { sessionCount: number; openCount: number; totalDifference: number; totalSupplies: number; totalWithdrawals: number };
};

export async function getCashReport(db: D1Database, tenantId: string, actor: Actor, input: CashReportInput = {}): Promise<CashReport> {
    requirePermission(actor.permissions, 'REPORT_VIEW');

    const storeFilter = input.storeId ? ' AND cs.store_id = ?' : '';
    const storeArgs = input.storeId ? [input.storeId] : [];

    const sessionRows = await db
        .prepare(
            `SELECT cs.id, cs.store_id AS storeId, st.name AS storeName, cs.operator, cs.opened_at AS openedAt,
                    cs.closed_at AS closedAt, cs.opening_amount AS opening, cs.counted_amount AS counted,
                    cs.expected_amount AS expected, cs.difference
             FROM cash_sessions cs
             JOIN stores st ON st.id = cs.store_id
             WHERE cs.tenant_id = ?${storeFilter}
             ORDER BY cs.opened_at DESC`,
        )
        .bind(tenantId, ...storeArgs)
        .all<{ id: string; storeId: string; storeName: string; operator: string; openedAt: number; closedAt: number | null; opening: number; counted: number | null; expected: number | null; difference: number | null }>();

    const movementRows = await db
        .prepare(
            `SELECT cm.cash_session_id AS sessionId, cm.type AS type, SUM(cm.amount) AS amount
             FROM cash_movements cm
             WHERE cm.tenant_id = ?
             GROUP BY cm.cash_session_id, cm.type`,
        )
        .bind(tenantId)
        .all<{ sessionId: string; type: string; amount: number }>();

    const movementsBySession = new Map<string, { supplies: number; withdrawals: number }>();
    for (const m of movementRows.results ?? []) {
        const entry = movementsBySession.get(m.sessionId) ?? { supplies: 0, withdrawals: 0 };
        if (m.type === 'SUPPLY') entry.supplies += m.amount;
        if (m.type === 'WITHDRAWAL') entry.withdrawals += m.amount;
        movementsBySession.set(m.sessionId, entry);
    }

    const sessions: CashReportSession[] = (sessionRows.results ?? []).map((s) => {
        const mv = movementsBySession.get(s.id) ?? { supplies: 0, withdrawals: 0 };
        return { ...s, supplies: mv.supplies, withdrawals: mv.withdrawals };
    });

    return {
        sessions,
        totals: {
            sessionCount: sessions.length,
            openCount: sessions.filter((s) => !s.closedAt).length,
            totalDifference: sessions.reduce((a, s) => a + (s.difference ?? 0), 0),
            totalSupplies: sessions.reduce((a, s) => a + s.supplies, 0),
            totalWithdrawals: sessions.reduce((a, s) => a + s.withdrawals, 0),
        },
    };
}

export type FiscalReportRow = { model: string; status: string; count: number };
export type FiscalReport = {
    byModelStatus: FiscalReportRow[];
    totalAuthorizedValue: number;
    pendingTransmissionCount: number;
};

export async function getFiscalReport(db: D1Database, tenantId: string, actor: Actor): Promise<FiscalReport> {
    requirePermission(actor.permissions, 'REPORT_VIEW');

    const byModelStatusRows = await db
        .prepare(`SELECT model, status, COUNT(*) AS count FROM fiscal_documents WHERE tenant_id = ? GROUP BY model, status ORDER BY model, status`)
        .bind(tenantId)
        .all<{ model: string; status: string; count: number }>();

    const authorizedValueRow = await db
        .prepare(
            `SELECT SUM(s.total) AS total
             FROM fiscal_documents fd
             JOIN sales s ON s.id = fd.sale_id
             WHERE fd.tenant_id = ? AND fd.status = 'AUTHORIZED'`,
        )
        .bind(tenantId)
        .first<{ total: number | null }>();

    const pendingRow = await db
        .prepare(`SELECT COUNT(*) AS count FROM fiscal_documents WHERE tenant_id = ? AND status IN ('GENERATED', 'SIGNED')`)
        .bind(tenantId)
        .first<{ count: number }>();

    return {
        byModelStatus: byModelStatusRows.results ?? [],
        totalAuthorizedValue: authorizedValueRow?.total ?? 0,
        pendingTransmissionCount: pendingRow?.count ?? 0,
    };
}
