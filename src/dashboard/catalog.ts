export const chartCatalog = [
  { id: 'colaboradores-tempo', label: 'Colaboradores no tempo', view: 'visao-geral', index: 0, grouping: 'Data', types: ['line', 'bar', 'table'] },
  { id: 'colaboradores-cargo', label: 'Colaboradores por cargo', view: 'visao-geral', index: 1, grouping: 'Data e cargo', types: ['line', 'bar', 'table'] },
  { id: 'colaboradores-nr', label: 'Colaboradores por NR do catálogo', view: 'visao-geral', index: 2, grouping: 'NR', types: ['bar', 'table'] },
  { id: 'turmas-nr', label: 'Turmas por NR no tempo', view: 'eventos', index: 0, grouping: 'Data e NR', types: ['line', 'bar', 'table'] },
  { id: 'conclusoes-nr', label: 'Participações concluídas por NR', view: 'eventos', index: 1, grouping: 'Data e NR', types: ['line', 'bar', 'table'] },
  { id: 'eventos-nr', label: 'Eventos por NR', view: 'eventos', index: 2, grouping: 'NR', types: ['bar', 'pie', 'table'] },
  { id: 'eventos-modo', label: 'Eventos por modo de conclusão', view: 'eventos', index: 3, grouping: 'Modo de conclusão', types: ['bar', 'pie', 'table'] },
  { id: 'eventos-gestor', label: 'Eventos por gestor', view: 'eventos', index: 4, grouping: 'Gestor', types: ['bar', 'pie', 'table'] },
] as const;
