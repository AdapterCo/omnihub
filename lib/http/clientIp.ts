import { isIP } from 'node:net';

// IP do cliente para auditoria e limite de tentativas. `cf-connecting-ip` e o primeiro item
// de `x-forwarded-for` são forjáveis por quem fala direto com o app; só o que o PRÓPRIO
// proxy confiável acrescentou é confiável. O Traefik acrescenta o endereço que ele viu ao
// fim da lista, então pega-se o N-ésimo item a partir do fim, N = TRUSTED_PROXY_HOPS
// (padrão 1 = só o Traefik; use 2 se houver outro proxy, como a Cloudflare, na frente).
export function clientIp(headers: Headers, env: Record<string, string | undefined> = process.env): string | null {
    const hops = Math.max(1, Math.floor(Number(env.TRUSTED_PROXY_HOPS)) || 1);
    const forwarded = (headers.get('x-forwarded-for') ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    const candidate = forwarded.length ? forwarded[Math.max(0, forwarded.length - hops)] : (headers.get('x-real-ip') ?? '').trim();
    return candidate && isIP(candidate) ? candidate : null;
}
