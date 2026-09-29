-- NFC-e: URL de consulta pela chave de acesso (urlChave), obrigatória no schema e própria de cada UF.
ALTER TABLE fiscal_configurations ADD COLUMN consulta_url text NOT NULL DEFAULT '';
