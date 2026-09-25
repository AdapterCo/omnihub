// Transforma o texto do QR (qr_data / Pix copia-e-cola) em imagem SVG no servidor.
// Usa o pacote `qrcode` SE estiver instalado; sem ele devolve null e a tela mostra só o
// código copia-e-cola (o pagamento continua possível pelo app do banco). A importação é
// dinâmica e por nome variável para o projeto compilar e rodar mesmo sem a dependência.
type QrModule = { toString(text: string, options: Record<string, unknown>): Promise<string> };

let cached: Promise<QrModule | null> | null = null;

function loadQrModule(): Promise<QrModule | null> {
    const moduleName = 'qrcode';
    cached ??= import(/* webpackIgnore: true */ moduleName)
        .then((mod: { default?: QrModule } & Partial<QrModule>) => (mod.default ?? (mod as QrModule)) as QrModule)
        .catch(() => null);
    return cached;
}

export async function qrSvg(text: string | null | undefined): Promise<string | null> {
    if (!text) return null;
    const mod = await loadQrModule();
    if (!mod) return null;
    try {
        return await mod.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
    } catch {
        return null;
    }
}
