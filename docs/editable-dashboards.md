# Configurações de painéis no MongoDB

Os dados analíticos continuam no Databricks. A API de dashboards persiste configurações na coleção `configuracoes_paineis`. Cada painel pertence ao usuário e workspace confirmados pelo Firebase e PostgreSQL; o cliente não escolhe esses identificadores. Painéis são pessoais dentro do workspace, como no armazenamento anterior.

Campos: `_id` (chave composta de workspace, usuário e UUID do painel), `painel_id` (UUID), `usuario_id` e `workspace_id` (strings de identificadores Astro), `nome`, `estilo`, `configuracao`, `versao`, `criado_em` e `atualizado_em` (datas BSON). A unicidade é garantida pelo índice `_id_`.

`configuracao` contém `filtros` (`inicio`, `fim`, `granularidade`) e `graficos` (`grafico_id`, `base_id`, `titulo`, `tipo`, `largura`, `consulta`). Receitas usam `base`, `agrupamento`, `serie`, `metrica`, `campo`, `operacao`, `formula`, `operador`, `operando`, `condicoes`, `valor`. Valores do catálogo permanecem identificadores técnicos; nomes de campos físicos são portugueses.

`estilo` aceita overview, trends, bars, donut, area, progress, comparison, scatter, activity e metrics. O contrato HTTP mantém nomes ingleses compatíveis com o web: `name`, `config.artwork`, `config.filters`, `config.widgets`.

- `GET /api/views`: lista painéis do usuário no workspace atual, ordenados pela última alteração.
- `PUT /api/views/{id}`: recebe `name`, `config`, `version`. UUID gerado pelo web. Versão zero cria; versão atual edita atomicamente e incrementa. UUID existente ou versão desatualizada retorna 409.
- `DELETE /api/views/{id}?version=N`: exclui somente no escopo atual e com a versão atual; conflito retorna 409, sucesso 204.

Corpos limitados a 128 KiB; até 12 gráficos, UUIDs distintos, nomes de até 120 caracteres, catálogo e receitas validados, datas reais e intervalo de até 366 dias. SQL livre e identificação de proprietário no corpo são recusados. Todas as rotas exigem autenticação e autorização atuais.

## Migração e publicação

Configurar os secrets `MONGODB_URI` e `MONGODB_DATABASE` no Worker antes de publicar API e web. A coleção nasce na primeira gravação; nenhuma consulta analítica é persistida. CORS permite GET, POST, PUT, DELETE e OPTIONS.

O web importa as visões antigas do localStorage, decodificando os marcadores de estilo dos títulos. Mantém os dados locais como cópia, marca a importação após sucesso e não escreve novos marcadores. IDs estáveis tornam tentativas repetidas seguras; um painel já existente no servidor prevalece. A importação é por navegador e conta/workspace; não é possível recuperar configurações de outro navegador sem abri-lo. Falhas não marcam a importação como concluída.

Atualização por foco da janela e após alterações; conflitos entre dispositivos exigem recarregar a visão. Não há atualização em tempo real por websocket.
