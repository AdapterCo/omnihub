-- Vendedor online cadastra unidade (2026-10-24, pedido do usuário): ele vende na hora e informa o
-- chassi/IMEI e a cor. Permissão própria UNIT_REGISTER (só cadastrar unidade): o cadastro aceita
-- STOCK_ADJUST (quem já movimentava estoque) ou UNIT_REGISTER. Remover unidade, entrada e ajuste de
-- estoque continuam exigindo STOCK_ADJUST.
INSERT INTO permissions (id, code) VALUES ('UNIT_REGISTER','UNIT_REGISTER') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_OWNER', id FROM permissions WHERE id = 'UNIT_REGISTER' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_ADMIN', id FROM permissions WHERE id = 'UNIT_REGISTER' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) SELECT 'ROLE_VENDEDOR_ONLINE', id FROM permissions WHERE id = 'UNIT_REGISTER' ON CONFLICT DO NOTHING;
