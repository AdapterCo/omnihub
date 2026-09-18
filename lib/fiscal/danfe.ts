import { RuleError } from '../errors.ts';

// DANFE (Documento Auxiliar da Nota Fiscal Eletrônica, modelo 55, §22 de instrucoes.md).
// "Gerar representação correspondente somente a partir dos dados fiscais válidos/
// autorizados" — por isso `buildDanfeHtml` nunca recebe dados soltos: só o que já foi
// persistido em `fiscal_documents` com status AUTHORIZED (ver `getDanfeData` em
// lib/fiscal/service.ts). Nunca inclui QR Code aqui: QR Code é exclusivo do DANFE de
// NFC-e (modelo 65, §20) — ver `buildDanfeNfceHtml` mais abaixo, função própria e
// separada (§20: "NF-e e NFC-e... sem serem tratadas como exatamente o mesmo documento").

export type DanfeItem = { code: string; description: string; ncm: string; cfop: string; unit: string; qty: number; unitPrice: number; totalPrice: number };
export type DanfePayment = { method: string; amount: number };

export type DanfeData = {
    accessKey: string;
    series: number;
    number: number;
    protocolNumber: string;
    authorizedAt: number;
    environment: 'homologacao' | 'producao';
    issuer: { legalName: string; tradeName?: string; cnpj: string; ie: string; address: string; number: string; district: string; city: string; uf: string; zip: string };
    recipient: { name: string; document: string };
    items: DanfeItem[];
    payments: DanfePayment[];
    total: number;
};

function formatMoney(cents: number): string {
    return (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatAccessKeyGroups(accessKey: string): string {
    return accessKey.replace(/(\d{4})(?=\d)/g, '$1 ').trim();
}

function formatDate(ms: number): string {
    return new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
}

function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Monta uma representação HTML do DANFE (modelo 55) a partir de dados já autorizados.
 * Não é o layout oficial impresso completo (que segue posições e dimensões específicas
 * do Anexo do MOC para impressão em formulário contínuo/A4) — é uma representação de
 * consulta/conferência com os campos obrigatórios de identificação da operação.
 */
export function buildDanfeHtml(data: DanfeData): string {
    if (data.environment !== 'homologacao' && data.environment !== 'producao') {
        throw new RuleError('Ambiente inválido para representação de DANFE.', 400);
    }
    const watermark = data.environment === 'homologacao' ? '<div class="danfe-watermark">SEM VALOR FISCAL — AMBIENTE DE HOMOLOGAÇÃO</div>' : '';

    const itemsRows = data.items
        .map(
            (item) => `<tr>
        <td>${escapeHtml(item.code)}</td>
        <td>${escapeHtml(item.description)}</td>
        <td>${escapeHtml(item.ncm)}</td>
        <td>${escapeHtml(item.cfop)}</td>
        <td>${escapeHtml(item.unit)}</td>
        <td class="num">${item.qty}</td>
        <td class="num">${formatMoney(item.unitPrice)}</td>
        <td class="num">${formatMoney(item.totalPrice)}</td>
      </tr>`,
        )
        .join('');

    const paymentsRows = data.payments.map((p) => `<tr><td>${escapeHtml(p.method)}</td><td class="num">${formatMoney(p.amount)}</td></tr>`).join('');

    return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>DANFE - NF-e ${data.series}/${data.number}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111;margin:16px}
.danfe-watermark{background:#c00;color:#fff;text-align:center;padding:6px;font-weight:bold;margin-bottom:12px}
h1{font-size:16px;margin:0 0 4px}
.header{border:1px solid #333;padding:8px;margin-bottom:8px;display:flex;justify-content:space-between}
.access-key{font-family:monospace;font-size:13px;letter-spacing:1px;text-align:center;border:1px solid #333;padding:6px;margin:8px 0}
table{width:100%;border-collapse:collapse;margin-bottom:8px}
th,td{border:1px solid #333;padding:4px 6px;font-size:11px;text-align:left}
.num{text-align:right}
.total{font-weight:bold}
.section-title{font-weight:bold;margin:10px 0 4px}
</style></head>
<body>
${watermark}
<h1>DANFE — Documento Auxiliar da Nota Fiscal Eletrônica</h1>
<p>Modelo 55 · Série ${data.series} · Número ${data.number} · Emitida em ${formatDate(data.authorizedAt)}</p>
<div class="header">
  <div>
    <strong>${escapeHtml(data.issuer.legalName)}</strong>${data.issuer.tradeName ? ` (${escapeHtml(data.issuer.tradeName)})` : ''}<br/>
    CNPJ: ${escapeHtml(data.issuer.cnpj)} · IE: ${escapeHtml(data.issuer.ie)}<br/>
    ${escapeHtml(data.issuer.address)}, ${escapeHtml(data.issuer.number)} — ${escapeHtml(data.issuer.district)}, ${escapeHtml(data.issuer.city)}/${escapeHtml(data.issuer.uf)} — CEP ${escapeHtml(data.issuer.zip)}
  </div>
  <div>
    <strong>Destinatário</strong><br/>
    ${escapeHtml(data.recipient.name)}<br/>
    Documento: ${escapeHtml(data.recipient.document)}
  </div>
</div>
<div class="access-key">Chave de Acesso: ${formatAccessKeyGroups(data.accessKey)}</div>
<p>Protocolo de Autorização: ${escapeHtml(data.protocolNumber)}</p>
<div class="section-title">Produtos / Serviços</div>
<table>
<thead><tr><th>Código</th><th>Descrição</th><th>NCM</th><th>CFOP</th><th>Un.</th><th>Qtd.</th><th>Vl. Unit.</th><th>Vl. Total</th></tr></thead>
<tbody>${itemsRows}</tbody>
</table>
<div class="section-title">Formas de Pagamento</div>
<table><tbody>${paymentsRows}</tbody></table>
<p class="total">Valor Total da NF-e: R$ ${formatMoney(data.total)}</p>
</body></html>`;
}

export type DanfeNfceData = {
    accessKey: string;
    series: number;
    number: number;
    protocolNumber: string;
    authorizedAt: number;
    environment: 'homologacao' | 'producao';
    qrCodeUrl: string;
    issuer: { legalName: string; tradeName?: string; cnpj: string };
    consumer?: { document: string } | null;
    items: DanfeItem[];
    payments: DanfePayment[];
    total: number;
};

/**
 * Monta uma representação HTML do DANFE NFC-e (modelo 65, §20) — formato compacto tipo
 * "cupom", com QR Code, distinto do DANFE de NF-e (que nunca inclui QR Code). Só recebe
 * dados de um documento já AUTHORIZED (mesma regra do §22 aplicada ao modelo 65).
 */
export function buildDanfeNfceHtml(data: DanfeNfceData): string {
    if (data.environment !== 'homologacao' && data.environment !== 'producao') {
        throw new RuleError('Ambiente inválido para representação de DANFE NFC-e.', 400);
    }
    const watermark = data.environment === 'homologacao' ? '<div class="danfe-watermark">SEM VALOR FISCAL — AMBIENTE DE HOMOLOGAÇÃO</div>' : '';

    const itemsRows = data.items
        .map(
            (item) => `<tr>
        <td>${escapeHtml(item.description)}</td>
        <td class="num">${item.qty}</td>
        <td class="num">${formatMoney(item.unitPrice)}</td>
        <td class="num">${formatMoney(item.totalPrice)}</td>
      </tr>`,
        )
        .join('');

    const paymentsRows = data.payments.map((p) => `<tr><td>${escapeHtml(p.method)}</td><td class="num">${formatMoney(p.amount)}</td></tr>`).join('');

    return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>DANFE NFC-e - ${data.series}/${data.number}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111;margin:16px;max-width:340px}
.danfe-watermark{background:#c00;color:#fff;text-align:center;padding:6px;font-weight:bold;margin-bottom:12px}
h1{font-size:14px;margin:0 0 4px;text-align:center}
.center{text-align:center}
table{width:100%;border-collapse:collapse;margin:8px 0}
th,td{border-bottom:1px dashed #999;padding:3px 2px;font-size:11px;text-align:left}
.num{text-align:right}
.total{font-weight:bold;font-size:13px}
.access-key{font-family:monospace;font-size:11px;word-break:break-all;text-align:center;border:1px solid #333;padding:6px;margin:8px 0}
.qr{text-align:center;margin:10px 0}
.qr a{font-size:10px;word-break:break-all}
hr{border:none;border-top:1px dashed #999}
</style></head>
<body>
${watermark}
<h1>DANFE NFC-e</h1>
<p class="center">${escapeHtml(data.issuer.legalName)}${data.issuer.tradeName ? ` (${escapeHtml(data.issuer.tradeName)})` : ''}<br/>CNPJ: ${escapeHtml(data.issuer.cnpj)}</p>
<p class="center">Modelo 65 · Série ${data.series} · Número ${data.number}<br/>${formatDate(data.authorizedAt)}</p>
<hr/>
<table>
<thead><tr><th>Item</th><th class="num">Qtd.</th><th class="num">Vl. Unit.</th><th class="num">Vl. Total</th></tr></thead>
<tbody>${itemsRows}</tbody>
</table>
<p class="total center">TOTAL: R$ ${formatMoney(data.total)}</p>
<div class="section-title">Formas de Pagamento</div>
<table><tbody>${paymentsRows}</tbody></table>
<p class="center">${data.consumer?.document ? `Consumidor: ${escapeHtml(data.consumer.document)}` : 'Consumidor não identificado'}</p>
<div class="access-key">${formatAccessKeyGroups(data.accessKey)}</div>
<p>Protocolo de Autorização: ${escapeHtml(data.protocolNumber)}</p>
<div class="qr"><p>Consulte pela Chave de Acesso ou pelo QR Code:</p><a href="${escapeHtml(data.qrCodeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(data.qrCodeUrl)}</a></div>
</body></html>`;
}
