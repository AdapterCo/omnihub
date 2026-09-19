// Fuso horário único do sistema (§61: "não espalhar conversões arbitrárias pelo código").
// O servidor roda em UTC (Docker), mas notas fiscais, caixa e relatórios pertencem ao dia e
// ao mês do horário de Brasília. O restante do projeto (comprovante, DANFE, painel) já
// formata em America/Sao_Paulo; este módulo concentra as conversões que precisam de partes
// da data (dia do relatório, AAMM da chave de acesso, dhEmi com offset).
export const APP_TIMEZONE = 'America/Sao_Paulo';

const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
});

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

export function localParts(ms: number): LocalParts {
    const values: Record<string, number> = {};
    for (const part of formatter.formatToParts(new Date(ms))) {
        if (part.type !== 'literal') values[part.type] = Number(part.value);
    }
    return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute, second: values.second };
}

const two = (n: number) => String(n).padStart(2, '0');

/** Dia (AAAA-MM-DD) no fuso do sistema. */
export function dayKey(ms: number): string {
    const p = localParts(ms);
    return `${p.year}-${two(p.month)}-${two(p.day)}`;
}

/** Offset do fuso no instante dado, no formato ±HH:MM (calculado, não fixo). */
export function offsetString(ms: number): string {
    const p = localParts(ms);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const offsetMinutes = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
    const sign = offsetMinutes < 0 ? '-' : '+';
    const abs = Math.abs(offsetMinutes);
    return `${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}

/** AAAA-MM-DDThh:mm:ss±HH:MM no horário local — formato de dhEmi/dhEvento da NF-e. */
export function isoWithOffset(ms: number): string {
    const p = localParts(ms);
    return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}:${two(p.second)}${offsetString(ms)}`;
}
