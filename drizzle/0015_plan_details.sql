-- Planos exibidos na página de cadastro (modelo do Adapter Connect): descrição e lista de recursos,
-- escritas pelo administrador da plataforma (uma linha por recurso). Nada pré-cadastrado.
ALTER TABLE platform_plans ADD COLUMN description text DEFAULT '' NOT NULL;
ALTER TABLE platform_plans ADD COLUMN features text DEFAULT '' NOT NULL;
