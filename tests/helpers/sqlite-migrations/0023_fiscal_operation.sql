-- Nota fiscal sem valores presumidos: natureza da operação configurada por loja (NF-e e NFC-e)
-- e forma de atendimento do pedido (presencial, internet, entrega) para o indPres.
ALTER TABLE fiscal_configurations ADD COLUMN nat_op text NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN sale_channel text NOT NULL DEFAULT '';
