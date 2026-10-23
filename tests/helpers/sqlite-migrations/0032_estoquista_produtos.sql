-- Estoquista cadastra produto (2026-10-23, pedido do usuário): passa a criar e editar produtos, além
-- de movimentar estoque e cadastrar unidades (chassi/IMEI), que já exigiam só STOCK_ADJUST.
-- Excluir produto continua só com Titular/Administrador.
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_ESTOQUISTA', id FROM permissions WHERE id IN ('PRODUCT_CREATE','PRODUCT_EDIT') ON CONFLICT DO NOTHING;
