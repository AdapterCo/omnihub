-- Assinatura da empresa em nome da loja (2026-10-22): no Adapter Sign, o papel da empresa passa a
-- ser assinado com a razão social da loja e um e-mail da empresa informado na configuração
-- (Minhas lojas > Assinatura eletrônica), em vez do nome e e-mail do vendedor que enviou. Sem valor
-- padrão: vazio bloqueia o envio com explicação. Quem enviou continua registrado (sent_by e externalId).
ALTER TABLE signature_configs ADD COLUMN company_email text DEFAULT '' NOT NULL;
