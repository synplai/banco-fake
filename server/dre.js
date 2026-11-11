import { get, moneyLimit, requireRule } from './db.js';

function dayStart(value) {
  requireRule(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Informe o período da DRE.');
  const utc = Date.parse(value + 'T00:00:00Z');
  requireRule(Number.isFinite(utc) && new Date(utc).toISOString().slice(0, 10) === value, 'Informe uma data válida.');
  return Date.parse(value + 'T00:00:00-03:00');
}

function adjustment(value) {
  if (value === undefined) return 0;
  requireRule(typeof value === 'string' && /^\d{1,12}$/.test(value) && Number(value) <= moneyLimit,
    'Informe valores de custos, despesas e tributos válidos.');
  return Number(value);
}

export async function establishmentDre(db, { team, start, end, salesTaxes, costs, expenses, incomeTaxes }) {
  requireRule(typeof team === 'string' && team.length, 'Selecione o estabelecimento.');
  const from = dayStart(start);
  const lastDay = dayStart(end);
  requireRule(from <= lastDay, 'A data inicial deve ser anterior ou igual à final.');
  const adjustments = {
    salesTaxes: adjustment(salesTaxes), costs: adjustment(costs), expenses: adjustment(expenses), incomeTaxes: adjustment(incomeTaxes)
  };
  const account = await get(db, "SELECT id,name,cnpj FROM accounts WHERE id=? AND role='team' AND deleted_at IS NULL", team);
  requireRule(account, 'Estabelecimento não encontrado.', 404);

  const totals = await get(db, `SELECT
      CAST(COALESCE(SUM(CASE WHEN sale.owner=? AND l.payee=sale.owner AND l.method IN ('pix','rfid') THEN l.amount END),0) AS BIGINT) AS sales,
      CAST(COALESCE(SUM(CASE WHEN original.owner=? AND l.payer=original.owner AND l.method='refund' THEN l.amount END),0) AS BIGINT) AS refunds,
      CAST(COALESCE(SUM(CASE WHEN l.method='terminal_fee' AND l.payer=? THEN l.amount
        WHEN l.method='terminal_fee_refund' AND l.payee=? THEN -l.amount END),0) AS BIGINT) AS "terminalFees",
      CAST(COALESCE(SUM(CASE WHEN l.method='fee' AND l.payer=? THEN l.amount END),0) AS BIGINT) AS "bankCharges"
    FROM ledger l
    LEFT JOIN operations sale ON sale.id=l.id AND sale.kind='sale'
    LEFT JOIN refunds r ON r.reversal=l.id
    LEFT JOIN operations original ON original.id=r.original AND original.kind='sale'
    WHERE l.archived_at IS NULL AND l.created>=? AND l.created<? AND (l.payer=? OR l.payee=?)`,
  team, team, team, team, team, from, lastDay + 86400000, team, team);

  const netRevenue = totals.sales - totals.refunds - adjustments.salesTaxes;
  const grossResult = netRevenue - adjustments.costs;
  const beforeIncomeTaxes = grossResult - totals.terminalFees - totals.bankCharges - adjustments.expenses;
  return { account, start, end, ...totals, ...adjustments, netRevenue, grossResult, beforeIncomeTaxes,
    netResult: beforeIncomeTaxes - adjustments.incomeTaxes };
}
