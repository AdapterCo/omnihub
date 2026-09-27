import { NextResponse, type NextRequest } from 'next/server';

// Política de segurança de conteúdo (CSP) das PÁGINAS com nonce por requisição
// (node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md): só roda script com o
// nonce desta resposta ou carregado por um script confiável ('strict-dynamic'). Sem
// 'unsafe-inline' em script: um script injetado numa página não executa. Estilos seguem com
// 'unsafe-inline' (atributos style do React). Rotas /api têm política própria, sem nenhum script
// (next.config.ts). Em desenvolvimento não se aplica (o modo dev usa eval/HMR).
export function proxy(request: NextRequest) {
 if (process.env.NODE_ENV !== 'production') return NextResponse.next();
 const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
 const csp = [
  "default-src 'self'",
  `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
 ].join('; ');
 const requestHeaders = new Headers(request.headers);
 requestHeaders.set('x-nonce', nonce);
 requestHeaders.set('Content-Security-Policy', csp);
 const response = NextResponse.next({ request: { headers: requestHeaders } });
 response.headers.set('Content-Security-Policy', csp);
 return response;
}

export const config = {
 matcher: [
  {
   source: '/((?!api|_next/static|_next/image|favicon.ico|favicon.svg).*)',
   missing: [
    { type: 'header', key: 'next-router-prefetch' },
    { type: 'header', key: 'purpose', value: 'prefetch' },
   ],
  },
 ],
};
