// Erro de domínio compartilhado entre lib/domain.ts e lib/authz (evita import circular).
export class RuleError extends Error {
 status: number;
 constructor(message: string, status = 400) {
  super(message);
  this.status = status;
 }
}
