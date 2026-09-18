-- Migração de dados (sem alteração de schema): move o que existir em `accounts.state`
-- (stores/products/stock/transfers) para as tabelas relacionais da Fase 2, preservando
-- os IDs já emitidos. Não apaga nem altera `accounts.state` — o JSON permanece como
-- registro histórico; a partir desta migração, a API para de lê-lo para essas quatro
-- entidades (ver app/api/workspace/route.ts). Idempotente: pode ser reaplicada sem
-- duplicar linhas (todas as instruções verificam `NOT EXISTS` antes de inserir).
-- Limitação conhecida: o JSON antigo guardava apenas o nome de exibição de quem pediu
-- uma transferência, não o user_id. `requested_by`/`operator` das transferências
-- migradas por aqui usam o sentinela 'legacy-import'; não é possível recuperar o autor
-- original sem ambiguidade.
INSERT INTO stores (id, tenant_id, name, legal_name, cnpj, ie, regime, uf, city, municipality_code, address, number, district, zip, created_at)
SELECT je.value->>'id', a.id, je.value->>'name', COALESCE(je.value->>'legalName',''), COALESCE(je.value->>'cnpj',''), COALESCE(je.value->>'ie',''), COALESCE(je.value->>'regime',''), COALESCE(je.value->>'uf',''), COALESCE(je.value->>'city',''), COALESCE(je.value->>'municipalityCode',''), COALESCE(je.value->>'address',''), COALESCE(je.value->>'number',''), COALESCE(je.value->>'district',''), COALESCE(je.value->>'zip',''), a.created_at
FROM accounts a, json_each(a.state, '$.stores') je
WHERE NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = je.value->>'id');
--> statement-breakpoint
INSERT INTO products (id, tenant_id, sku, barcode, name, unit, cost_price, sale_price, min_stock, active, created_at)
SELECT je.value->>'id', a.id, je.value->>'sku', COALESCE(je.value->>'barcode',''), je.value->>'name', je.value->>'unit', je.value->>'cost', je.value->>'price', je.value->>'minimum', 1, a.created_at
FROM accounts a, json_each(a.state, '$.products') je
WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = je.value->>'id');
--> statement-breakpoint
INSERT INTO product_fiscal_profiles (id, product_id, ncm, cest, origin, tax_code, legacy_cfop)
SELECT lower(hex(randomblob(16))), je.value->>'id', COALESCE(je.value->>'ncm',''), COALESCE(je.value->>'cest',''), COALESCE(je.value->>'origin',''), COALESCE(je.value->>'taxCode',''), COALESCE(je.value->>'cfop','')
FROM accounts a, json_each(a.state, '$.products') je
WHERE NOT EXISTS (SELECT 1 FROM product_fiscal_profiles f WHERE f.product_id = je.value->>'id');
--> statement-breakpoint
INSERT INTO inventories (id, tenant_id, store_id, product_id, quantity)
SELECT lower(hex(randomblob(16))), a.id, outer_je.key, inner_je.key, inner_je.value
FROM accounts a, json_each(a.state, '$.stock') outer_je, json_each(outer_je.value) inner_je
WHERE NOT EXISTS (SELECT 1 FROM inventories i WHERE i.store_id = outer_je.key AND i.product_id = inner_je.key);
--> statement-breakpoint
INSERT INTO stock_movements (id, tenant_id, store_id, product_id, type, quantity, previous_quantity, new_quantity, reference_type, reference_id, user_id, created_at)
SELECT lower(hex(randomblob(16))), a.id, outer_je.key, inner_je.key, 'INITIAL', inner_je.value, 0, inner_je.value, 'backfill', NULL, 'legacy-import', a.created_at
FROM accounts a, json_each(a.state, '$.stock') outer_je, json_each(outer_je.value) inner_je
WHERE NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.store_id = outer_je.key AND sm.product_id = inner_je.key AND sm.reference_type = 'backfill');
--> statement-breakpoint
INSERT INTO stock_transfers (id, tenant_id, from_store_id, to_store_id, status, requested_by, notes, created_at, dispatched_at, received_at)
SELECT je.value->>'id', a.id, je.value->>'from', je.value->>'to', CASE je.value->>'status' WHEN 'received' THEN 'RECEIVED' ELSE 'IN_TRANSIT' END, 'legacy-import', '', COALESCE(je.value->>'createdAt', a.created_at), COALESCE(je.value->>'createdAt', a.created_at), je.value->>'receivedAt'
FROM accounts a, json_each(a.state, '$.transfers') je
WHERE NOT EXISTS (SELECT 1 FROM stock_transfers t WHERE t.id = je.value->>'id');
--> statement-breakpoint
INSERT INTO stock_transfer_items (id, transfer_id, product_id, quantity)
SELECT lower(hex(randomblob(16))), je.value->>'id', je.value->>'productId', je.value->>'qty'
FROM accounts a, json_each(a.state, '$.transfers') je
WHERE NOT EXISTS (SELECT 1 FROM stock_transfer_items i WHERE i.transfer_id = je.value->>'id');
