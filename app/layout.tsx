import type { Metadata } from 'next';
import { Bricolage_Grotesque, Public_Sans } from 'next/font/google';
import './globals.css';
// Fontes servidas pelo próprio app (next/font baixa no build): títulos/valores em Bricolage Grotesque,
// texto em Public Sans. Nada é carregado do Google no navegador, então a CSP não muda.
const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-display', display: 'swap' });
const text = Public_Sans({ subsets: ['latin'], variable: '--font-text', display: 'swap' });
// Renderização dinâmica: o nonce da CSP (proxy.ts) é aplicado por requisição, o que não existe em
// página gerada no build.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {title:'OmniHub — Gestão de lojas',description:'Vendas, estoque e caixa de todas as suas lojas em um só lugar.',icons:{icon:'/favicon.svg'}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="pt-BR" className={`${display.variable} ${text.variable}`}><body>{children}</body></html>}
