import { z } from 'zod';
import type { WorkspaceContext } from '../auth/workspace';
import type { QueryExecutor, SqlParameter } from '../databricks';
import type { DatabricksSettings } from '../env';
import { ApiError } from '../errors';
import { granularities, type Filters } from './filters';

export const operations = ['count', 'distinct', 'sum', 'avg', 'min', 'max'] as const;
type Operation = typeof operations[number];
type Field = { id: string; label: string; description: string; value: string; kind: 'identifier' | 'text' | 'date' | 'number'; sourceColumn: string | null; expression: string; operations: readonly Operation[]; groupable: boolean };
type Dataset = { id: string; label: string; description: string; dateField: string; dateDescription: string; fields: Field[] };
function field(id: string, label: string, kind: Field['kind'], description: string, value: string, expression = `t.\`${id}\``, sourceColumn: string | null = id): Field {
  return { id, label, kind, description, value, expression, sourceColumn, operations: kind === 'number' ? operations : ['count', 'distinct'], groupable: kind !== 'number' };
}
const quantity = () => field('registros', 'Quantidade de registros', 'number', 'Cada linha vale 1. Somar este campo equivale a contar os registros encontrados.', 'Mostra o volume de registros da base; pode incluir mais de um registro da mesma pessoa.', '1', null);
const snapshot = () => field('snapshot_date', 'Data da carga', 'date', 'Dia em que o registro foi levado para o Databricks. Não representa necessariamente o dia do evento.', 'Ajuda a acompanhar as cargas disponíveis.');
const unitId = (expression = 't.id_unidade') => field('unidade', 'Unidade', 'identifier', 'Identifica a unidade à qual o registro pertence.', 'Permite comparar as unidades do seu acesso.', expression, expression.split('.').at(-1)!);
const personId = (id = 'id_usuario', label = 'Pessoa', expression = `t.${id}`) => field(id, label, 'identifier', 'Código único da pessoa. Prefira contar pessoas diferentes para evitar repetições.', 'Responde quantas pessoas distintas aparecem no recorte.', expression);
export const explorerDatasets: Dataset[] = [
  { id: 'usuario', label: 'Pessoas', description: 'Cadastros de colaboradores e gestores, com perfil e situação.', dateField: 'snapshot_date', dateDescription: 'Nesta base, as datas filtram a data da carga, não a admissão.', fields: [personId(), field('nome', 'Nome da pessoa', 'text', 'Nome cadastrado no Astro; pessoas diferentes podem ter nomes iguais.', 'Permite agrupar registros por nome. Para contar pessoas, use o código da pessoa.'), field('tipo', 'Perfil da pessoa', 'text', 'Indica se a pessoa é colaborador, gestor ou gestor do workspace.', 'Ajuda a entender a composição da equipe.'), field('status', 'Situação do cadastro', 'text', 'Situação atual informada no cadastro, como ativo ou inativo.', 'Permite acompanhar pessoas por situação.'), unitId('t.unidade_id'), field('cargo_id', 'Código do cargo', 'identifier', 'Identificador do cargo cadastrado. Esta base não contém o nome do cargo.', 'Permite contar cargos diferentes ou agrupar pessoas por cargo.'), snapshot(), quantity()] },
  { id: 'unidade', label: 'Unidades', description: 'Unidades cadastradas e disponíveis no seu acesso.', dateField: 'snapshot_date', dateDescription: 'As datas filtram o dia da carga da unidade.', fields: [field('id_unidade', 'Código da unidade', 'identifier', 'Código único da unidade.', 'Conte unidades diferentes para saber quantas unidades existem.'), field('nome', 'Nome da unidade', 'text', 'Nome da unidade cadastrada.', 'Permite comparar unidades pelo nome.'), snapshot(), quantity()] },
  { id: 'colaborador_posicao', label: 'Histórico de colaboradores', description: 'Registros de colaboradores e cargos ao longo do tempo.', dateField: 'data_evento', dateDescription: 'As datas filtram o dia do registro no histórico.', fields: [personId('id_colaborador', 'Colaborador'), field('cargo', 'Cargo', 'text', 'Nome do cargo no registro do histórico.', 'Mostra como os colaboradores se distribuem entre os cargos.'), field('data_evento', 'Data do registro', 'date', 'Dia ao qual o registro do histórico se refere.', 'Permite acompanhar a evolução por dia, semana, mês ou ano.'), unitId(), quantity()] },
  { id: 'dim_nr_catalogo', label: 'Normas por unidade', description: 'Normas regulamentadoras relacionadas às unidades.', dateField: 'snapshot_date', dateDescription: 'As datas filtram o dia da carga do catálogo de normas.', fields: [field('codigo_nr', 'Norma regulamentadora', 'identifier', 'Código da NR. A mesma norma pode existir em várias unidades.', 'Conte normas diferentes ou compare a presença de cada NR por unidade.'), unitId(), snapshot(), quantity()] },
  { id: 'evento', label: 'Eventos de capacitação', description: 'Eventos, normas, responsáveis e formas de conclusão.', dateField: 'snapshot_date', dateDescription: 'As datas filtram a carga do evento. Para usar a data de início, escolha Turmas.', fields: [field('id_evento', 'Evento', 'identifier', 'Código único do evento de capacitação.', 'Conte eventos diferentes para acompanhar o total de eventos.'), field('status', 'Situação do evento', 'text', 'Situação do evento, incluindo cancelados quando houver.', 'Permite comparar situações e filtrar cancelamentos.'), field('nr_id', 'Norma do evento', 'identifier', 'Identificador da norma vinculada ao evento.', 'Permite distribuir os eventos por norma.'), field('gestor_id', 'Gestor responsável', 'identifier', 'Código do gestor responsável pelo evento.', 'Permite contar gestores diferentes ou agrupar seus eventos.'), field('modo_conclusao', 'Forma de conclusão', 'text', 'Forma prevista para concluir o evento.', 'Ajuda a comparar os tipos de conclusão.'), snapshot(), quantity()] },
  { id: 'turma', label: 'Turmas', description: 'Turmas de eventos de capacitação e suas datas de início.', dateField: 'data_inicial', dateDescription: 'As datas filtram o início da turma.', fields: [field('id_turma', 'Turma', 'identifier', 'Código único da turma.', 'Conte turmas diferentes para saber quantas turmas foram abertas.'), field('data_inicial', 'Início da turma', 'date', 'Data de início da turma de capacitação.', 'Permite acompanhar a programação ao longo do tempo.'), field('evento_id', 'Evento da turma', 'identifier', 'Código do evento que reúne a turma.', 'Permite contar eventos que tiveram turmas no período.'), snapshot(), quantity()] },
  { id: 'turma_colaborador', label: 'Participações em turmas', description: 'Vínculos de pessoas com turmas. A mesma pessoa pode participar de várias turmas.', dateField: 'inicio_turma', dateDescription: 'As datas filtram o início da turma vinculada à participação.', fields: [field('id_turma_colaborador', 'Participação', 'identifier', 'Código único do vínculo entre uma pessoa e uma turma.', 'Conte participações diferentes para medir inscrições sem duplicar o vínculo.'), personId('usuario_id', 'Participante'), field('turma_id', 'Turma', 'identifier', 'Código da turma da participação.', 'Permite comparar a quantidade de participantes por turma.'), field('inicio_turma', 'Início da turma', 'date', 'Data de início obtida da turma vinculada.', 'Permite analisar participações ao longo do tempo.', 'class.data_inicial', null), snapshot(), quantity()] },
  { id: 'conclusao_evento', label: 'Conclusões de capacitação', description: 'Registros de conclusão e validação das participações.', dateField: 'data_conclusao', dateDescription: 'As datas filtram o dia da conclusão. Registros sem uma data válida não entram nesse período.', fields: [field('id_conclusao_evento', 'Conclusão', 'identifier', 'Código único do registro de conclusão.', 'Conte conclusões diferentes para acompanhar entregas realizadas.'), field('turma_colaborador_id', 'Participação vinculada', 'identifier', 'Código da participação a que a conclusão se refere.', 'Permite contar participações com registro de conclusão.'), field('status', 'Situação da conclusão', 'text', 'Situação registrada para a conclusão, como concluído.', 'Permite comparar ou filtrar as situações.'), field('data_conclusao', 'Data de conclusão', 'date', 'Dia informado para a conclusão da participação.', 'Permite acompanhar entregas ao longo do tempo.'), field('data_validacao', 'Data de validação', 'date', 'Dia em que a conclusão foi validada, quando informado.', 'Ajuda a acompanhar quando as entregas foram validadas.'), field('dias_validacao', 'Dias até a validação', 'number', 'Diferença, em dias, entre conclusão e validação. Datas ausentes, inválidas ou invertidas não entram no cálculo.', 'Use média para medir o tempo de espera; mínimo e máximo mostram os extremos.', 'CASE WHEN TRY_CAST(t.data_validacao AS DATE) >= TRY_CAST(t.data_conclusao AS DATE) THEN datediff(TRY_CAST(t.data_validacao AS DATE), TRY_CAST(t.data_conclusao AS DATE)) ELSE NULL END', null), snapshot(), quantity()] },
];

const aggregateSchema = z.strictObject({ field: z.string().min(1).max(80), operation: z.enum(operations) });
export const explorerQuerySchema = z.strictObject({
  dataset: z.string().min(1).max(80), groupBy: z.string().min(1).max(80), series: z.string().min(1).max(80).optional(),
  metric: aggregateSchema,
  formula: z.strictObject({ operator: z.enum(['add', 'subtract', 'multiply', 'divide', 'percentage']), operand: aggregateSchema }).optional(),
  where: z.array(z.strictObject({ field: z.string().min(1).max(80), operator: z.enum(['equals', 'not_equals']), value: z.string().trim().min(1).max(120) })).max(3).default([]),
}).refine(query => {
  const dataset = explorerDatasets.find(item => item.id === query.dataset);
  if (!dataset) return false;
  const byId = (id: string) => dataset.fields.find(item => item.id === id);
  const validMetric = (metric: z.infer<typeof aggregateSchema>) => byId(metric.field)?.operations.includes(metric.operation);
  return (query.groupBy === 'none' || byId(query.groupBy)?.groupable) && (!query.series || (query.groupBy !== 'none' && query.series !== query.groupBy && byId(query.series)?.groupable && byId(query.series)?.kind !== 'date'))
    && validMetric(query.metric) && (!query.formula || validMetric(query.formula.operand)) && query.where.every(condition => ['text', 'identifier'].includes(byId(condition.field)?.kind ?? ''));
});
export type ExplorerQuery = z.infer<typeof explorerQuerySchema>;
export function explorerChartTypes(query: ExplorerQuery): string[] {
  const dataset = explorerDatasets.find(item => item.id === query.dataset);
  if (!dataset) return [];
  if (dataset.fields.find(item => item.id === query.groupBy)?.kind === 'date') return ['line', 'bar'];
  return query.series || query.formula || ['distinct', 'avg', 'min', 'max'].includes(query.metric.operation) ? ['bar'] : ['bar', 'pie'];
}
export function publicExplorerCatalog(config: DatabricksSettings) {
  return { version: '2026-10-23.1', datasets: explorerDatasets.map(dataset => ({ ...dataset, source: `${config.DATABRICKS_CATALOG}.${config.DATABRICKS_SCHEMA}.${dataset.id}`, fields: dataset.fields.map(({ expression: _expression, ...item }) => item) })) };
}
function fromDataset(id: string, table: (name: string) => string): string {
  const own = 'JOIN authorized_units own_scope ON own_scope.id_unidade =';
  if (id === 'usuario') return `${table(id)} t ${own} t.unidade_id`;
  if (['unidade', 'colaborador_posicao', 'dim_nr_catalogo'].includes(id)) return `${table(id)} t ${own} t.id_unidade`;
  const manager = `JOIN ${table('usuario')} manager ON manager.id_usuario = event.gestor_id JOIN authorized_units manager_scope ON manager_scope.id_unidade = manager.unidade_id`;
  if (id === 'evento') return `${table(id)} t JOIN ${table('usuario')} manager ON manager.id_usuario = t.gestor_id ${own} manager.unidade_id`;
  if (id === 'turma') return `${table(id)} t JOIN ${table('evento')} event ON event.id_evento = t.evento_id ${manager}`;
  const participant = `JOIN ${table('usuario')} person ON person.id_usuario = participation.usuario_id JOIN authorized_units participant_scope ON participant_scope.id_unidade = person.unidade_id`;
  if (id === 'turma_colaborador') return `${table(id)} t JOIN ${table('turma')} class ON class.id_turma = t.turma_id JOIN ${table('evento')} event ON event.id_evento = class.evento_id ${manager} JOIN ${table('usuario')} person ON person.id_usuario = t.usuario_id JOIN authorized_units participant_scope ON participant_scope.id_unidade = person.unidade_id`;
  return `${table('conclusao_evento')} t JOIN ${table('turma_colaborador')} participation ON participation.id_turma_colaborador = t.turma_colaborador_id ${participant} JOIN ${table('turma')} class ON class.id_turma = participation.turma_id JOIN ${table('evento')} event ON event.id_evento = class.evento_id ${manager}`;
}
const operationLabels: Record<Operation, string> = { count: 'Contagem', distinct: 'Contagem distinta', sum: 'Soma', avg: 'Média', min: 'Mínimo', max: 'Máximo' };
export async function loadExplorer(query: ExplorerQuery, filters: Filters, scope: WorkspaceContext, config: DatabricksSettings, executor: QueryExecutor) {
  const dataset = explorerDatasets.find(item => item.id === query.dataset)!;
  const getField = (id: string) => dataset.fields.find(item => item.id === id)!;
  const group = query.groupBy === 'none' ? null : getField(query.groupBy);
  const series = query.series ? getField(query.series) : null;
  const table = (name: string) => `\`${config.DATABRICKS_CATALOG}\`.\`${config.DATABRICKS_SCHEMA}\`.\`${name}\``;
  const aggregate = (metric: ExplorerQuery['metric']) => {
    const expression = getField(metric.field).expression;
    const functions: Record<Operation, string> = { count: `COUNT(${expression})`, distinct: `COUNT(DISTINCT ${expression})`, sum: `SUM(${expression})`, avg: `AVG(${expression})`, min: `MIN(${expression})`, max: `MAX(${expression})` };
    return `CAST(${functions[metric.operation]} AS DOUBLE)`;
  };
  const metricLabel = `${operationLabels[query.metric.operation]} de ${getField(query.metric.field).label.toLocaleLowerCase('pt-BR')}`;
  let measure = aggregate(query.metric), title = metricLabel;
  if (query.formula) {
    const other = aggregate(query.formula.operand), op = query.formula.operator;
    measure = ['divide', 'percentage'].includes(op) ? `CASE WHEN (${other}) <> 0 THEN (${measure}) / (${other})${op === 'percentage' ? ' * 100.0' : ''} ELSE NULL END` : `(${measure}) ${op === 'add' ? '+' : op === 'subtract' ? '-' : '*'} (${other})`;
    title += ` ${ { add: '+', subtract: '−', multiply: '×', divide: '÷', percentage: '÷' }[op]} ${operationLabels[query.formula.operand.operation].toLocaleLowerCase('pt-BR')} de ${getField(query.formula.operand.field).label.toLocaleLowerCase('pt-BR')}${op === 'percentage' ? ' (%)' : ''}`;
  }
  const groupExpr = (item: Field) => item.kind === 'date' ? `CAST(CAST(date_trunc(:granularity, TRY_CAST(${item.expression} AS DATE)) AS DATE) AS STRING)` : `CAST(${item.expression} AS STRING)`;
  const dimensions = [group?.kind === 'date' ? 'data' : 'categoria', ...(series ? ['serie'] : [])];
  const selected = [`${group ? `COALESCE(${groupExpr(group)}, 'Sem classificação')` : "'Total'"} AS ${dimensions[0]}`, ...(series ? [`COALESCE(${groupExpr(series)}, 'Sem classificação') AS serie`] : [])];
  const parameters: SqlParameter[] = [
    { name: 'authorized_unit_ids', value: JSON.stringify(scope.unitIds), type: 'STRING' },
    { name: 'start_date', value: filters.start, type: 'DATE' }, { name: 'end_date', value: filters.end, type: 'DATE' },
    ...(group?.kind === 'date' ? [{ name: 'granularity', value: granularities[filters.granularity], type: 'STRING' as const }] : []),
    ...query.where.map((condition, index) => ({ name: `condition_${index}`, value: condition.value, type: 'STRING' as const })),
  ];
  const conditions = query.where.map((condition, index) => `lower(CAST(${getField(condition.field).expression} AS STRING)) ${condition.operator === 'equals' ? '=' : '<>'} lower(:condition_${index})`);
  const sql = `WITH authorized_units AS (SELECT explode(from_json(:authorized_unit_ids, 'array<string>')) AS id_unidade)
    SELECT ${selected.join(', ')}, (${measure}) AS valor
    FROM ${fromDataset(dataset.id, table)}
    WHERE TRY_CAST(${getField(dataset.dateField).expression} AS DATE) BETWEEN :start_date AND :end_date${conditions.length ? ` AND ${conditions.join(' AND ')}` : ''}
    ${group ? `GROUP BY ${dimensions.map((_, index) => index + 1).join(', ')}` : ''} ORDER BY ${dimensions.map((_, index) => index + 1).join(', ')}`;
  const rows = scope.unitIds.length ? await executor.execute(sql, parameters) : [];
  let undefinedGroups = 0;
  const output: Record<string, string | number>[] = [];
  for (const row of rows) {
    if (row.valor == null) { undefinedGroups++; continue; }
    const value = Number(row.valor);
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new ApiError(502, 'invalid_metric', 'O cálculo retornou um valor fora do limite de exibição.');
    output.push(Object.fromEntries([...dimensions.map(dimension => [dimension, String(row[dimension] ?? 'Sem classificação')]), ['valor', value]]));
  }
  return { workspaceId: scope.workspaceId, dataSource: 'databricks' as const, generatedAt: new Date().toISOString(), filters: { start: filters.start, end: filters.end, granularity: filters.granularity },
    chart: { title, kind: group?.kind === 'date' ? 'line' as const : 'bar' as const, dimensions, measure: 'valor', metricLabel: title, format: query.formula?.operator === 'percentage' ? 'percent' as const : 'number' as const, dateSensitive: true, undefinedGroups, rows: output } };
}
