import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {title:'OmniHub — Gestão de lojas',description:'Vendas, estoque e caixa de todas as suas lojas em um só lugar.',icons:{icon:'/favicon.svg'}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="pt-BR"><body>{children}</body></html>}
