-- Busca de clientes no servidor (2026-11-20, pedido do usuário): lojas com milhares de clientes.
-- search_text: nome, documento, telefone, e-mail e cidade normalizados (minúsculas, sem acento, só
-- dígitos no documento/telefone), gravado pelo serviço no cadastro/edição. Clientes antigos ficam com
-- '' e são preenchidos pelo próprio serviço na primeira busca da conta (a normalização é feita em JS).
ALTER TABLE customers ADD COLUMN search_text text DEFAULT '' NOT NULL;
