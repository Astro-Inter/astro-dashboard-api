# Catálogo de cálculos e cache

## Rotas

- `GET /api/explorer/catalog`: bases autorizadas, campos, rótulos, descrições, utilidade, tipo lógico e operações compatíveis. As expressões SQL não são enviadas ao navegador.
- `POST /api/explorer/query`: recebe `{ query, filters }` e devolve um gráfico agregado do workspace autenticado.
- O frontend persiste `query` em um widget com `datasetId: "custom"` pela API /api/views, na coleção Mongo configuracoes_paineis, separada por usuário e workspace. As receitas são validadas tanto ao salvar como ao calcular; os resultados continuam no Databricks.

Exemplo: pessoas diferentes por perfil.

```json
{
  "query": {
    "dataset": "usuario",
    "groupBy": "tipo",
    "metric": { "field": "id_usuario", "operation": "distinct" },
    "where": []
  },
  "filters": { "start": "2026-07-26", "end": "2026-10-23", "granularity": "mes" }
}
```

O catálogo usa as oito bases já autorizadas: pessoas, unidades, histórico de colaboradores, normas por unidade, eventos, turmas, participações e conclusões. Cada base tem um caminho de autorização fixo até as unidades do workspace. Participações e conclusões verificam tanto a unidade do participante quanto a do gestor do evento. As tabelas relacionadas para esse caminho não podem ser escolhidas pelo cliente.

## Cálculos

IDs, textos e datas permitem contagem de valores preenchidos e contagem sem repetir. Os campos numéricos calculados permitem soma, média, mínimo e máximo. O catálogo atual do lake tem campos físicos STRING; `registros` é uma constante 1 por linha e `dias_validacao` é a diferença válida e não negativa entre datas de validação e conclusão. São medidas derivadas, identificadas assim no catálogo.

É possível combinar duas agregações da mesma base por adição, subtração, multiplicação, divisão ou percentual. Há um agrupamento principal, um detalhamento opcional e até três filtros de igualdade/diferença, todos restritos aos campos da base. Datas respeitam o limite de 366 dias e usam o campo de data descrito em cada base. Em bases de cadastro, esse campo é a data da carga, sem representar admissão/criação.

O cliente não envia SQL, funções, joins nem nomes arbitrários de tabelas/colunas. Valores dos filtros são parâmetros SQL. Campo, operação, agrupamento, detalhamento e tipo de gráfico passam pela validação do servidor. Contagens distintas, médias, extremos, fórmulas e séries temporais não oferecem pizza no editor, evitando apresentar esses resultados como parcelas somáveis de um total. Não há edição livre de SQL ou cálculo entre bases diferentes.

Resultados sem valores ou com divisor zero são omitidos do gráfico e contabilizados em `chart.undefinedGroups`. A interface informa essa ausência; não converte a ausência em zero. Números negativos e decimais são aceitos no gráfico de barras/linhas. Valores não finitos ou acima do limite seguro de representação são rejeitados.

## Cache de até 90 segundos

O cache é em memória de cada instância do Worker: máximo de 32 entradas, 8 MB no total e 1 MB por resultado. Pode desaparecer em reinícios, publicações ou distribuição entre instâncias; portanto nem toda chamada repetida terá hit. Somente respostas completas e bem-sucedidas são guardadas. Não se compartilham Promises nem I/O entre requisições.

A autorização Firebase e a consulta atual de vínculo no Astro acontecem **antes** de todo hit. A chave inclui usuário, workspace, papel, unidades atuais autorizadas, origem/configuração Databricks e definição completa da consulta. Alterar o acesso ou trocar de usuário não reutiliza a entrada antiga. Não há cache de decisões de autorização, erros, tokens ou configurações salvas, e o HTTP continua `Cache-Control: no-store`.

Respostas incluem `cache: { hit, ttlSeconds: 90, expiresAt }`, mantendo `generatedAt` da consulta original. O header `X-Dashboard-Refresh: 1` ignora/substitui a entrada e consulta a fonte. O CORS já permite esse header. A redução de tempo aplica-se às consultas Databricks; a autorização atual continua com seu custo normal.

## Publicação posterior

Publicar a nova API é necessário para o frontend de produção usar catálogo, cálculos e cache. Não foi realizado deploy nesta alteração. As permissões SELECT das oito tabelas já existentes são reaproveitadas; nenhuma permissão nova é criada por uma requisição do editor.
