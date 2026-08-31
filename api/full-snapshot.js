// /api/full-snapshot.js
export default async function handler(req, res) {
  const ticker = (req.query.ticker || '').toUpperCase();
  if (!ticker) {
    return res.status(400).json({ error: 'Missing ticker param' });
  }

  // Table retention rules (from your spreadsheet)
  const tableRules = {
    "shibui.general_info": { mode: "keep_full" },
    "shibui.analyst_estimates": { mode: "keep_full" },
    "shibui.ownership_stats": { mode: "keep_full" },
    "shibui.stock_quotes": { mode: "last_days", days: 30, orderDesc: true, limit: 1000 },
    "shibui.technical_indicators": { mode: "last_days", days: 10, orderDesc: true, limit: 500 },
    "shibui.valuation": { mode: "last_days", days: 10, orderDesc: true, limit: 500 },
    "shibui.fundamentals_quarterly": { mode: "last_quarters", quarters: 8, orderDesc: true, limit: 100 },
    "shibui.fundamentals_yearly": { mode: "last_years", years: 10, orderDesc: true, limit: 50 },
    "shibui.fundamentals_derived_quarterly": { mode: "last_quarters", quarters: 16, orderDesc: true, limit: 100 },
    "shibui.fundamentals_derived_daily": { mode: "last_days", days: 10, orderDesc: true, limit: 500 },
    "shibui.earnings_quarterly": { mode: "last_quarters", quarters: 16, orderDesc: true, limit: 100 }
    // skip sec_filings
  };

  try {
    const results = {};

    for (const [table, rule] of Object.entries(tableRules)) {
      let whereClauses = [`ticker='${ticker}'`];
      let orderClause = '';
      let limitClause = rule.limit ? `LIMIT ${rule.limit}` : '';

      if (rule.mode === 'last_days') {
        whereClauses.push(`date >= CURRENT_DATE - INTERVAL '${rule.days} days'`);
        if (rule.orderDesc) orderClause = 'ORDER BY date DESC';
      } else if (rule.mode === 'last_quarters') {
        whereClauses.push(`date >= CURRENT_DATE - INTERVAL '${rule.quarters * 3} months'`);
        if (rule.orderDesc) orderClause = 'ORDER BY date DESC';
      } else if (rule.mode === 'last_years') {
        whereClauses.push(`date >= CURRENT_DATE - INTERVAL '${rule.years} years'`);
        if (rule.orderDesc) orderClause = 'ORDER BY date DESC';
      }

      const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
      const sql = `SELECT * FROM ${table} ${whereSql} ${orderClause} ${limitClause};`;

      const parsed = await callTool("stock_data_query", {
        user_prompt: `Dump fields for ${ticker} from ${table} with retention rule`,
        query: sql
      }, Date.now());

      let data = parsed?.result ?? parsed;
      if (data && typeof data === 'object') {
        if (data.structuredContent?.result) {
          data = data.structuredContent.result;
        } else if (Array.isArray(data.content) && data.content.length === 1 && typeof data.content[0].text === 'string') {
          data = data.content[0].text;
        }
      }

      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch {}
      }

      if (Array.isArray(data)) {
        data = data.map(row => {
          if (row && typeof row === 'object') {
            for (const [k, v] of Object.entries(row)) {
              if (typeof v === 'string') {
                const trimmed = v.trim();
                if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                  try { row[k] = JSON.parse(trimmed); } catch {}
                }
              }
            }
          }
          return row;
        });
      }

      results[table] = data;
    }

    res.status(200).json({ ticker, data: results });
  } catch (err) {
    console.error('Error in full-snapshot route:', err);
    res.status(500).json({ error: err.message });
  }
}
