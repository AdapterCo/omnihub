import type { Metadata } from 'next';
import './globals.css';
// Renderização dinâmica: o nonce da CSP (proxy.ts) é aplicado por requisição, o que não existe em
// página gerada no build.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {title:'OmniHub — Gestão de lojas',description:'Vendas, estoque e caixa de todas as suas lojas em um só lugar.',icons:{icon:'/favicon.svg'}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="pt-BR"><body>{children}</body></html>}
