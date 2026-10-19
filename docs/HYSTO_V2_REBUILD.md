# Hysto V2 — reconstrução isolada

Esta branch é destinada à reconstrução do aplicativo. A interface atual será preservada como referência visual; a lógica de dados e de mensagens será refeita progressivamente.

## Isolamento obrigatório

- Não mesclar esta branch na `main` antes dos testes e da aprovação.
- Usar **um novo projeto Supabase**, com URL e chave publicável próprias, conectado ao projeto de testes no Lovable.
- Nunca reutilizar credenciais, banco ou Storage de produção para testes.
- Não executar as migrações V2 no Supabase antigo.
- Não copiar mensagens, personagens ou usuários do aplicativo antigo sem uma migração planejada e autorizada.
- As tabelas da V2 terão prefixo `v2_` para evitar colisões durante a transição.

## Fases

1. Fundação: Supabase de testes, esquema V2, autenticação e RLS.
2. Personagens e personas: criação, edição, imagens e configuração de perfil padrão.
3. Conversas: mensagens persistidas com IDs UUID reais, ordenação estável e operações seguras.
4. Regeneração: **nunca apagar** a mensagem original; gerar uma nova versão de resposta e definir a versão ativa apenas após sucesso.
5. Memória: fatos, estado da cena e resumo separados, com editor manual e trilha de alterações.
6. IA: conhecimento limitado ao personagem, idioma consistente e formatação validada.
7. Testes: fluxos de erro, concorrência, mensagens repetidas e verificação de integridade.

## Regras inegociáveis do chat

- Nenhuma ação de regenerar, reenviar ou atualizar pode executar `DELETE`.
- Exclusão só ocorre mediante ação explícita, confirmação e ID UUID validado.
- A interface nunca identifica uma mensagem apenas pelo texto.
- A resposta antiga permanece visível até a nova versão ser persistida.
- Histórico, memória e respostas são isolados por usuário e conversa.
- Toda gravação no banco tem tratamento de erro; falhas não apagam dados.
- Um teste de cada funcionalidade deve ser concluído antes da próxima fase.

## Configuração de testes

1. Criar novo projeto Lovable para a V2, preservando o projeto atual.
2. Conectar novo Supabase na integração do Lovable; configurar variáveis `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` conforme o ambiente.
3. Aplicar **somente no novo banco** as migrações V2 aprovadas.
4. Confirmar autenticação, RLS e persistência antes de habilitar geração por IA.

> Criar a branch e estes arquivos não conecta automaticamente Lovable ou Supabase. Essa autorização deve ser feita na conta do projeto de testes.
