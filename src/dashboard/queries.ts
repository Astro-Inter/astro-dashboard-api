import type { DatabricksSettings } from '../env';

export function buildQueries(config: DatabricksSettings) {
  const table = (name: string) => `\`${config.DATABRICKS_CATALOG}\`.\`${config.DATABRICKS_SCHEMA}\`.\`${name}\``;
  const scope = `WITH authorized_units AS (
    SELECT explode(from_json(:authorized_unit_ids, 'array<string>')) AS id_unidade
  )`;
  const positions = `${scope}, scoped_positions AS (
    SELECT p.* FROM ${table('colaborador_posicao')} p
    JOIN authorized_units au ON au.id_unidade = p.id_unidade
    WHERE CAST(p.data_evento AS DATE) BETWEEN :start_date AND :end_date
  )`;
  const classes = `${scope}, scoped_classes AS (
    SELECT DISTINCT t.id_turma, CAST(t.data_inicial AS DATE) AS data_inicial, e.nr_id
    FROM ${table('turma')} t
    JOIN ${table('evento')} e ON e.id_evento = t.evento_id
    JOIN ${table('usuario')} gestor ON gestor.id_usuario = e.gestor_id
    JOIN authorized_units manager_scope ON manager_scope.id_unidade = gestor.unidade_id
    WHERE lower(e.status) <> 'cancelado'
      AND lower(gestor.tipo) IN ('gestor', 'gestor_workspace')
      AND lower(gestor.status) = 'ativo'
      AND CAST(t.data_inicial AS DATE) BETWEEN :start_date AND :end_date
  ), scoped_participations AS (
    SELECT DISTINCT tf.id_turma_funcionario, tf.turma_id, tf.usuario_id
    FROM ${table('turma_funcionario')} tf
    JOIN scoped_classes sc ON sc.id_turma = tf.turma_id
    JOIN ${table('usuario')} participante ON participante.id_usuario = tf.usuario_id
    JOIN authorized_units participant_scope ON participant_scope.id_unidade = participante.unidade_id
    WHERE lower(participante.tipo) = 'colaborador' AND lower(participante.status) = 'ativo'
  ), completed_participations AS (
    SELECT DISTINCT sp.id_turma_funcionario
    FROM scoped_participations sp
    JOIN ${table('conclusao_evento')} ce ON ce.turma_funcionario_id = sp.id_turma_funcionario
    WHERE lower(ce.status) = 'concluido'
  )`;

  return {
    overviewSummary: `${scope}
      SELECT
        (SELECT COUNT(DISTINCT p.id_colaborador) FROM ${table('colaborador_posicao')} p
         JOIN authorized_units au ON au.id_unidade = p.id_unidade
         WHERE CAST(p.data_evento AS DATE) = :end_date) AS colaboradores,
        (SELECT COUNT(DISTINCT nr.codigo_nr) FROM ${table('dim_nr_catalogo')} nr
         JOIN authorized_units au ON au.id_unidade = nr.id_unidade) AS nrs,
        (SELECT COUNT(DISTINCT u.id_unidade) FROM ${table('unidade')} u
         JOIN authorized_units au ON au.id_unidade = u.id_unidade) AS unidades,
        (SELECT COUNT(DISTINCT usr.id_usuario) FROM ${table('usuario')} usr
         JOIN authorized_units au ON au.id_unidade = usr.unidade_id
         WHERE lower(usr.tipo) IN ('gestor', 'gestor_workspace') AND lower(usr.status) = 'ativo') AS gestores`,
    overviewTimeline: `${positions}
      SELECT CAST(date_trunc(:granularity, CAST(data_evento AS DATE)) AS DATE) AS data,
             COUNT(DISTINCT id_colaborador) AS total
      FROM scoped_positions GROUP BY 1 ORDER BY 1`,
    overviewRoles: `${positions}
      SELECT CAST(date_trunc(:granularity, CAST(data_evento AS DATE)) AS DATE) AS data,
             COALESCE(cargo, 'Sem cargo') AS cargo, COUNT(DISTINCT id_colaborador) AS total
      FROM scoped_positions GROUP BY 1, 2 ORDER BY 1, 2`,
    overviewNrs: `${positions}
      SELECT CAST(nr.codigo_nr AS STRING) AS codigo_nr, COUNT(DISTINCT p.id_colaborador) AS total
      FROM scoped_positions p JOIN ${table('dim_nr_catalogo')} nr ON nr.id_unidade = p.id_unidade
      GROUP BY 1 ORDER BY 1`,
    eventsSummary: `${classes}
      SELECT COUNT(DISTINCT sc.id_turma) AS turmas, COUNT(DISTINCT sp.usuario_id) AS participantes,
             COUNT(DISTINCT cp.id_turma_funcionario) AS participacoes_concluidas
      FROM scoped_classes sc
      LEFT JOIN scoped_participations sp ON sp.turma_id = sc.id_turma
      LEFT JOIN completed_participations cp ON cp.id_turma_funcionario = sp.id_turma_funcionario`,
    eventsTimeline: `${classes}
      SELECT CAST(date_trunc(:granularity, sc.data_inicial) AS DATE) AS data,
             CAST(sc.nr_id AS STRING) AS nr_id, COUNT(DISTINCT sc.id_turma) AS turmas,
             COUNT(DISTINCT cp.id_turma_funcionario) AS participacoes_concluidas
      FROM scoped_classes sc
      LEFT JOIN scoped_participations sp ON sp.turma_id = sc.id_turma
      LEFT JOIN completed_participations cp ON cp.id_turma_funcionario = sp.id_turma_funcionario
      GROUP BY 1, 2 ORDER BY 1, 2`,
    eventsDistribution: `${scope}
      SELECT CAST(e.nr_id AS STRING) AS nr_id, e.modo_conclusao,
             CONCAT(gestor.nome, ' #', gestor.id_usuario) AS gestor, COUNT(DISTINCT e.id_evento) AS total
      FROM ${table('evento')} e
      JOIN ${table('usuario')} gestor ON gestor.id_usuario = e.gestor_id
      JOIN authorized_units au ON au.id_unidade = gestor.unidade_id
      WHERE lower(e.status) <> 'cancelado'
        AND lower(gestor.tipo) IN ('gestor', 'gestor_workspace') AND lower(gestor.status) = 'ativo'
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
  };
}
