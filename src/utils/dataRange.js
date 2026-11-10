// src/utils/dateRange.js

/**
 * Parses a dateRange string from the API query into { start, end } Date objects.
 * Supported values: 'all', 'all_time', 'today', 'yesterday', 'last_7_days',
 * 'last_30_days', 'this_month', 'last_month', 'this_year',
 * or a custom range 'YYYY-MM-DD,YYYY-MM-DD'.
 *
 * Returns { start: null, end: null } for "all time".
 */
export function parseDateRange(dateRange) {
  if (!dateRange) return { start: null, end: null };

  const key = String(dateRange).toLowerCase().replace(/[\s+]/g, '_');
  if (key === 'all_time' || key === 'all') return { start: null, end: null };

  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  switch (key) {
    case 'today':
      return { start, end };

    case 'yesterday': {
      const s = new Date(start);
      s.setDate(s.getDate() - 1);
      const e = new Date(end);
      e.setDate(e.getDate() - 1);
      return { start: s, end: e };
    }

    case 'last_7_days':
      start.setDate(start.getDate() - 6);
      return { start, end };

    case 'last_30_days':
      start.setDate(start.getDate() - 29);
      return { start, end };

    case 'this_week': {
      const day = start.getDay(); // 0=Sun .. 6=Sat
      start.setDate(start.getDate() - day);
      return { start, end };
    }

    case 'this_month':
      start.setDate(1);
      return { start, end };

    case 'last_month': {
      start.setMonth(start.getMonth() - 1);
      start.setDate(1);
      end.setDate(0); // last day of previous month
      end.setHours(23, 59, 59, 999);
      return { start, end };
    }

    case 'this_year':
      start.setMonth(0, 1);
      return { start, end };

    case 'last_year': {
      start.setFullYear(start.getFullYear() - 1, 0, 1);
      end.setFullYear(end.getFullYear(), 0, 0); // Dec 31 of previous year
      end.setHours(23, 59, 59, 999);
      return { start, end };
    }

    default:
      // Custom: 'YYYY-MM-DD,YYYY-MM-DD'
      if (String(dateRange).includes(',')) {
        const [s, e] = String(dateRange).split(',');
        const startDate = new Date(s.trim());
        const endDate = new Date(e.trim());
        endDate.setHours(23, 59, 59, 999);
        return { start: startDate, end: endDate };
      }
      return { start: null, end: null };
  }
}

/**
 * Flexible date filter builder.
 *
 * Usage 1: getDateFilter('last_7_days', 'createdAt')
 *   -> { createdAt: { $gte: Date, $lte: Date } }   (Sequelize-friendly)
 *
 * Usage 2: getDateFilter('last_7_days')
 *   -> { start: Date, end: Date }                 (range object)
 *
 * Usage 3: getDateFilter('all_time', 'createdAt')
 *   -> {}                                          (no filter, spreadable)
 *
 * Usage 4: getDateFilter('all_time')
 *   -> { start: null, end: null }
 */
export function getDateFilter(dateRange, column) {
  const { start, end } = parseDateRange(dateRange);

  if (!start && !end) return column ? {} : { start: null, end: null };

  if (column) {
    const range = {};
    if (start) range.$gte = start;
    if (end) range.$lte = end;
    return { [column]: range };
  }

  return { start, end };
}

/**
 * Sequelize Op-style builder (uses [Op.gte]/[Op.lte] if you import Op).
 * Pass the Op object from sequelize to keep imports out of this util.
 *
 *   import { Op } from 'sequelize';
 *   const filter = getDateFilterOp('last_7_days', 'createdAt', Op);
 *   // -> { createdAt: { [Op.gte]: Date, [Op.lte]: Date } }
 */
export function getDateFilterOp(dateRange, column, Op) {
  const { start, end } = parseDateRange(dateRange);
  if (!start && !end) return {};
  if (!column) return { start, end };
  const range = {};
  if (start) range[Op.gte] = start;
  if (end) range[Op.lte] = end;
  return { [column]: range };
}

// Aliases — keep old names working in case other controllers import them
export const buildDateFilter = getDateFilter;
export const buildRangeClause = getDateFilter;

export default {
  parseDateRange,
  getDateFilter,
  getDateFilterOp,
  buildDateFilter,
  buildRangeClause,
};