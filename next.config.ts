import type { NextConfig } from "next";

// Cabeçalhos de segurança em todas as respostas. A CSP das PÁGINAS usa nonce por requisição e fica
// em proxy.ts (sem 'unsafe-inline' em script). Aqui fica só a CSP das rotas /api (JSON, DANFE em
// HTML, PDFs/imagens de documentos): nenhum script é necessário nelas, então nenhum é permitido.
// Só em produção: o modo dev do Next usa eval/websocket de HMR.
const isProduction = process.env.NODE_ENV === "production";
const apiContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(isProduction
    ? [
        { key: "Strict-Transport-Security", value: "max-age=31536000" },
      ]
    : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      ...(isProduction ? [{ source: "/api/:path*", headers: [{ key: "Content-Security-Policy", value: apiContentSecurityPolicy }] }] : []),
    ];
  },
};

export default nextConfig;
