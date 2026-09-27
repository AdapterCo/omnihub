import nodemailer from 'nodemailer';

// Envio de e-mail por SMTP próprio da empresa (decisão do usuário). Nada é presumido: sem todas as
// variáveis abaixo o envio fica desligado e a tela orienta a pedir ao administrador.
//   SMTP_HOST, SMTP_PORT, SMTP_SECURE (true = TLS direto, típico da porta 465; false = STARTTLS,
//   típico da 587), SMTP_USER, SMTP_PASS, SMTP_FROM (remetente) e APP_URL (endereço público do
//   OmniHub, usado no link enviado — nunca deduzido do cabeçalho da requisição).
export type MailMessage = { to: string; subject: string; text: string; html: string };
export type Mailer = { send(message: MailMessage): Promise<void>; appUrl: string };

export function mailConfigProblems(env: Record<string, string | undefined> = process.env): string[] {
 const missing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'APP_URL'].filter((k) => !(env[k] ?? '').trim());
 const problems = missing.map((k) => `${k} não definida`);
 const port = Number(env.SMTP_PORT);
 if (env.SMTP_PORT && (!Number.isInteger(port) || port < 1 || port > 65535)) problems.push('SMTP_PORT inválida');
 if (env.SMTP_SECURE && !['true', 'false'].includes(env.SMTP_SECURE.trim().toLowerCase())) problems.push('SMTP_SECURE deve ser true ou false');
 if (env.APP_URL) {
  try {
   const u = new URL(env.APP_URL.trim());
   const local = ['localhost', '127.0.0.1'].includes(u.hostname);
   if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) problems.push('APP_URL deve usar https');
  } catch {
   problems.push('APP_URL inválida');
  }
 }
 return problems;
}

export function mailerFromEnv(env: Record<string, string | undefined> = process.env): Mailer | null {
 if (mailConfigProblems(env).length) return null;
 const transport = nodemailer.createTransport({
  host: env.SMTP_HOST!.trim(),
  port: Number(env.SMTP_PORT),
  secure: env.SMTP_SECURE!.trim().toLowerCase() === 'true',
  auth: { user: env.SMTP_USER!.trim(), pass: env.SMTP_PASS! },
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 30_000,
 });
 const from = env.SMTP_FROM!.trim();
 return {
  appUrl: env.APP_URL!.trim().replace(/\/+$/, ''),
  async send(message) {
   await transport.sendMail({ from, to: message.to, subject: message.subject, text: message.text, html: message.html });
  },
 };
}

export function escapeHtml(text: string): string {
 return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
