import { z } from 'zod';
import { ApiError } from '../errors';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const filtersSchema = z.strictObject({
  view: z.enum(['visao-geral', 'eventos']).default('visao-geral'),
  start: date,
  end: date,
  granularity: z.enum(['dia', 'semana', 'mes', 'ano']).default('mes'),
}).refine((value) => {
  const days = (Date.parse(value.end) - Date.parse(value.start)) / 86_400_000 + 1;
  return days >= 1 && days <= 366;
});

export type Filters = z.infer<typeof filtersSchema>;
export const granularities = { dia: 'day', semana: 'week', mes: 'month', ano: 'year' } as const;

export function parseFilters(search: URLSearchParams): Filters {
  const names = [...search.keys()];
  if (new Set(names).size !== names.length) {
    throw new ApiError(422, 'invalid_filters', 'Não repita parâmetros de filtro.');
  }
  const parsed = filtersSchema.safeParse(Object.fromEntries(search));
  if (!parsed.success) {
    throw new ApiError(422, 'invalid_filters', 'Informe datas válidas, intervalo de até 366 dias, visão e granularidade permitidas. IDs de workspace e unidade não são filtros públicos.');
  }
  return parsed.data;
}
