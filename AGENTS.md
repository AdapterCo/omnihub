# Instruções permanentes do projeto

A especificação funcional e arquitetural de referência é [instrucoes.md](instrucoes.md), mantida pelo usuário.

- Leia `instrucoes.md` integralmente ao iniciar trabalho neste projeto. Releia os trechos aplicáveis antes de implementar e sempre que houver dúvida. Não substitua a especificação por memória da conversa ou por este resumo.
- Siga a análise inicial e a execução incremental exigidas nas seções 74, 75 e 78. Não tente implementar todos os tópicos de uma vez nem reescrever o projeto sem necessidade.
- Não invente requisitos, regras comerciais, valores de planos, prazos, limites, dados cadastrais, classificações ou regras fiscais. Identifique lacunas; peça os dados necessários antes de implementar decisões que dependam deles. Propostas técnicas devem ser identificadas como propostas.
- Preserve funções e dados existentes. Explique problema, motivo, impacto e solução de mudanças estruturais. Migrações publicadas são imutáveis; planeje novas migrações, reconciliação e recuperação antes da troca de persistência.
- Autorização, tenant, permissões, assinatura, estoque e integridade monetária devem ser garantidos no backend e no banco; a interface não é fronteira de segurança.
- Separe venda, documento fiscal e comprovante comercial. Nunca simule autorização, chave, protocolo, XML autorizado ou habilitação na SEFAZ. Mocks são exclusivamente para testes, explicitamente identificados.
- Para implementação fiscal, consulte fontes oficiais vigentes e registre versões técnicas. Dados obrigatórios ausentes bloqueiam emissão; não preencha por suposição. Comece por NF-e 55 em homologação conforme a ordem da especificação; NFS-e fica para o futuro.
- `docs/analise-inicial.md` registra diagnóstico e propostas, não cria requisitos adicionais nem substitui `instrucoes.md`.
- Não altere `instrucoes.md` para acomodar o código. Se instruções novas do usuário mudarem a especificação, explicite a divergência.
- Relate de forma distinta: implementado, validado, proposto, pendente e dependente de integração/configuração externa. Não declare o projeto comercialmente pronto sem evidências.
