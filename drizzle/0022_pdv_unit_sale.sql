-- Venda de aparelho à vista no PDV (2026-10-24, pedido do usuário): o aparelho cadastrado com IMEI
-- (produto do tipo Locação) pode ser vendido na Frente de caixa, sem contrato, escolhendo a unidade.
-- product_units.sale_id: venda do PDV que levou a unidade (status SOLD); cancelar a venda devolve.
-- sale_items.unit_id/unit_serial: unidade vendida naquela linha (o IMEI sai no comprovante).
ALTER TABLE product_units ADD COLUMN sale_id text;
ALTER TABLE sale_items ADD COLUMN unit_id text;
ALTER TABLE sale_items ADD COLUMN unit_serial text DEFAULT '' NOT NULL;
