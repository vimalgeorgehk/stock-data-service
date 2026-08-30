// index.js
const express = require('express');
//const fetch = require('node-fetch'); // If Node v18+, remove this and use global fetch
const app = express();

const MCP_URL = 'https://mcp.shibui.finance/mcp';

// --- Helpers ---
async function parseSSE(response) {
  const text = await response.text();
  const lines = text.split("\n");
  const dataLine = lines.find(line => line.startsWith("data:"));
  if (dataLine) {
    const jsonStr = dataLine.replace("data: ", "");
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      return { error: "Failed to parse JSON from SSE data line", raw: jsonStr };
    }
  }
  return { error: "No data line found", raw: text };
}

async function callTool(name, args = {}, id = 1) {
  const resp = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args }
    })
  });
  return await parseSSE(resp);
}

// --- Routes ---
app.get('/schema', async (req, res) => {
  try {
    const parsed = await callTool('get_database_schema', {}, 100);
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/patterns', async (req, res) => {
  try {
    const parsed = await callTool('get_query_patterns', {}, 110);
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Snapshot route
app.get('/snapshot', async (req, res) => {
  const ticker = (req.query.ticker || '').toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'Missing ticker param' });

  try {
    await callTool('get_database_schema', {}, 1001);
    await callTool('get_query_patterns', {}, 1002);

    const sql = `
WITH
latest_val AS (
  SELECT symbol, market_cap, enterprise_value, price_to_book, date,
         ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
  FROM shibui.valuation
  WHERE ticker = '${ticker}' AND date >= CURRENT_DATE - INTERVAL '14 days'
),
latest_dd AS (
  SELECT symbol, free_cash_flow_yield, free_cash_flow_per_share, trailing_pe, operating_pe, dividend_yield,
         ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
  FROM shibui.fundamentals_derived_daily
  WHERE ticker = '${ticker}' AND date >= CURRENT_DATE - INTERVAL '14 days'
),
recent_q AS (
  SELECT symbol, date, revenue, net_income, free_cash_flow,
         ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
  FROM shibui.fundamentals_quarterly
  WHERE ticker = '${ticker}' AND revenue IS NOT NULL
),
ttm AS (
  SELECT symbol,
         SUM(revenue) AS ttm_revenue,
         SUM(net_income) AS ttm_net_income,
         SUM(free_cash_flow) AS ttm_fcf,
         ROUND(SUM(net_income) / NULLIF(SUM(revenue),0), 4) AS ttm_margin,
         ROUND(SUM(free_cash_flow) / NULLIF(SUM(revenue),0), 4) AS fcf_margin_ttm
  FROM recent_q WHERE rn <= 4
  GROUP BY symbol
),
latest_fy AS (
  SELECT symbol, year, revenue, net_income, free_cash_flow, profit_margin,
         ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY year DESC) AS rn
  FROM shibui.fundamentals_yearly
  WHERE ticker = '${ticker}'
),
latest_tech AS (
  SELECT ti.symbol, ti.date, ti.sma_20, ti.sma_50, ti.sma_200, ti.rsi_14,
         ROW_NUMBER() OVER (PARTITION BY ti.symbol ORDER BY ti.date DESC) AS rn
  FROM shibui.technical_indicators ti
  WHERE ti.ticker = '${ticker}' AND ti.date >= CURRENT_DATE - INTERVAL '90 days'
),
hi52 AS (
  SELECT symbol,
         MAX(high) OVER (PARTITION BY symbol ORDER BY date ROWS BETWEEN 251 PRECEDING AND CURRENT ROW) AS wk52_high,
         MIN(low)  OVER (PARTITION BY symbol ORDER BY date ROWS BETWEEN 251 PRECEDING AND CURRENT ROW) AS wk52_low,
         ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
  FROM shibui.stock_quotes
  WHERE ticker = '${ticker}' AND date >= CURRENT_DATE - INTERVAL '53 weeks'
),
recent_filings AS (
  SELECT sf.form_type, sf.filing_date, sf.report_date, sf.filing_url, sf.accession_number,
         ROW_NUMBER() OVER (ORDER BY sf.filing_date DESC) AS rn
  FROM shibui.sec_filings sf
  WHERE sf.cik = (SELECT g.cik FROM shibui.general_info g WHERE g.ticker = '${ticker}')
    AND sf.filing_date >= CURRENT_DATE - INTERVAL '2 years'
)
SELECT
  g.ticker, g.name, g.exchange,
  v.market_cap, v.enterprise_value, v.price_to_book,
  dd.free_cash_flow_yield, dd.trailing_pe, dd.operating_pe, dd.dividend_yield,
  ttm.ttm_revenue, ttm.ttm_net_income, ttm.ttm_fcf, ttm.ttm_margin, ttm.fcf_margin_ttm,
  fy.revenue AS revenue_annual, fy.free_cash_flow AS free_cash_flow_annual, fy.profit_margin AS profit_margin_annual, fy.year,
  tech.sma_20, tech.sma_50, tech.sma_200, tech.rsi_14,
  h.wk52_high, h.wk52_low,
  rf.form_type, rf.filing_date, rf.report_date, rf.filing_url, rf.accession_number
FROM shibui.general_info g
LEFT JOIN (SELECT * FROM latest_val WHERE rn = 1) v ON v.symbol = g.symbol
LEFT JOIN (SELECT * FROM latest_dd WHERE rn = 1) dd ON dd.symbol = g.symbol
LEFT JOIN ttm ON ttm.symbol = g.symbol
LEFT JOIN (SELECT * FROM latest_fy WHERE rn = 1) fy ON fy.symbol = g.symbol
LEFT JOIN (SELECT * FROM latest_tech WHERE rn = 1) tech ON tech.symbol = g.symbol
LEFT JOIN (SELECT * FROM hi52 WHERE rn = 1) h ON h.symbol = g.symbol
LEFT JOIN (SELECT * FROM recent_filings WHERE rn <= 5) rf ON rf.accession_number IS NOT NULL
WHERE g.ticker = '${ticker}'
LIMIT 1;
`.trim();

    const response = await callTool('stock_data_query', {
      user_prompt: `${ticker} full snapshot`,
      query: sql
    }, 1003);

    res.json({
      requested: { ticker, sql_preview: sql.slice(0, 800) },
      response
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(3000, () => console.log('API running locally on port 3000'));
