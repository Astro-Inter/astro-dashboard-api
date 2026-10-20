import type { WorkspaceContext } from '../auth/workspace';
import type { QueryExecutor, Row, SqlParameter } from '../databricks';
import type { DatabricksSettings } from '../env';
import { ApiError } from '../errors';
import { granularities, type Filters } from './filters';
import { buildQueries } from './queries';

function count(value: unknown): number {
  const numeric = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new ApiError(502, 'invalid_metric', 'Indicador inválido retornado pela fonte de dados.');
  }
  return numeric;
}

function chart(title: string, kind: 'line' | 'bar', dimensions: string[], measure: string, rows: Row[], dateSensitive = true) {
  return {
    title, kind, dimensions, measure, dateSensitive,
    rows: rows.map((row) => Object.fromEntries([
      ...dimensions.map((key) => [key, row[key] == null ? 'Sem classificação' : String(row[key])]),
      [measure, count(row[measure])],
    ])),
  };
}

function grouped(rows: Row[], field: string): Row[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = String(row[field] ?? 'Sem classificação');
    totals.set(key, (totals.get(key) ?? 0) + count(row.total));
  }
  return [...totals].map(([key, total]) => ({ [field]: key, total }));
}

export function parametersFor(sql: string, filters: Filters, workspace: WorkspaceContext): SqlParameter[] {
  const available: SqlParameter[] = [
    { name: 'authorized_unit_ids', value: JSON.stringify(workspace.unitIds), type: 'STRING' },
    { name: 'start_date', value: filters.start, type: 'DATE' },
    { name: 'end_date', value: filters.end, type: 'DATE' },
    { name: 'granularity', value: granularities[filters.granularity], type: 'STRING' },
  ];
  const names = new Set([...sql.matchAll(/:([a-z_]+)/g)].map((match) => match[1]));
  return available.filter((parameter) => names.has(parameter.name));
}

function summary(rows: Row[]): Row {
  if (rows.length !== 1 || !rows[0]) throw new ApiError(502, 'invalid_query_response', 'Resposta inválida da fonte de dados.');
  return rows[0];
}

export async function loadDashboard(filters: Filters, workspace: WorkspaceContext,
  config: DatabricksSettings, executor: QueryExecutor) {
  const queries = buildQueries(config);
  const base = {
    view: filters.view, workspaceId: workspace.workspaceId, filters,
    dataSource: 'databricks' as const, generatedAt: new Date().toISOString(),
  };
  const run = (sql: string) => executor.execute(sql, parametersFor(sql, filters, workspace));
  const kpi = (key: string, label: string, value: unknown, dateSensitive = true) => ({ key, label, value: count(value), format: 'number', dateSensitive });

  if (filters.view === 'visao-geral') {
    const [summaryRows, timeline, roles, nrs] = workspace.unitIds.length
      ? await Promise.all([run(queries.overviewSummary), run(queries.overviewTimeline), run(queries.overviewRoles), run(queries.overviewNrs)])
      : [[{ colaboradores: 0, nrs: 0, unidades: 0, gestores: 0 }], [], [], []];
    const metrics = summary(summaryRows);
    return {
      ...base, title: 'Visão Geral',
      kpis: [
        kpi('colaboradores', 'Colaboradores na data final', metrics.colaboradores),
        kpi('nrs', 'NRs no catálogo das unidades', metrics.nrs, false),
        kpi('unidades', 'Unidades no lake', metrics.unidades, false),
        kpi('gestores', 'Gestores ativos no lake', metrics.gestores, false),
      ],
      charts: [
        chart('Colaboradores no tempo', 'line', ['data'], 'total', timeline),
        chart('Colaboradores por cargo no tempo', 'line', ['data', 'cargo'], 'total', roles),
        chart('Colaboradores por NR do catálogo da unidade', 'bar', ['codigo_nr'], 'total', nrs),
      ],
    };
  }

  const [summaryRows, timeline, distribution] = workspace.unitIds.length
    ? await Promise.all([run(queries.eventsSummary), run(queries.eventsTimeline), run(queries.eventsDistribution)])
    : [[{ turmas: 0, participantes: 0, participacoes_concluidas: 0 }], [], []];
  const metrics = summary(summaryRows);
  return {
    ...base, title: 'Eventos',
    kpis: [
      kpi('turmas', 'Turmas no período', metrics.turmas),
      kpi('participantes', 'Colaboradores participantes', metrics.participantes),
      kpi('concluidas', 'Participações concluídas', metrics.participacoes_concluidas),
    ],
    charts: [
      chart('Turmas por NR no tempo', 'line', ['data', 'nr_id'], 'turmas', timeline),
      chart('Participações concluídas por NR no tempo', 'line', ['data', 'nr_id'], 'participacoes_concluidas', timeline),
      chart('Eventos por NR', 'bar', ['nr_id'], 'total', grouped(distribution, 'nr_id'), false),
      chart('Eventos por modo de conclusão', 'bar', ['modo_conclusao'], 'total', grouped(distribution, 'modo_conclusao'), false),
      chart('Eventos por gestor', 'bar', ['gestor'], 'total', grouped(distribution, 'gestor'), false),
    ],
  };
}
