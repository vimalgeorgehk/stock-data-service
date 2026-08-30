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
  SELECT symbol, free_cash_flow_yield, trailing_pe, operating_pe, dividend_yield,
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
  SELECT symbol, year, revenue, net_income, free_cash_flow, profit_margin, book_value, total_assets, equity,
         ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY year DESC) AS rn
  FROM shibui.fundamentals_yearly
  WHERE ticker = '${ticker}'
),
hist_fy AS (
  SELECT symbol, year, revenue, net_income, free_cash_flow, profit_margin, book_value, total_assets, equity, shares_outstanding
  FROM shibui.fundamentals_yearly
  WHERE ticker = '${ticker}'
  ORDER BY year DESC
  LIMIT 10
),
agg5 AS (
  SELECT
    AVG(net_income) AS avg_net_income_5yr,
    AVG(free_cash_flow) AS avg_fcf_5yr,
    AVG(profit_margin) AS avg_profit_margin_5yr,
    EXP((LN(MAX(revenue)) - LN(MIN(revenue)))/5) - 1 AS cagr_revenue_5yr,
    EXP((LN(MAX(book_value)) - LN(MIN(book_value)))/5) - 1 AS cagr_book_5yr
  FROM (SELECT * FROM hist_fy ORDER BY year DESC LIMIT 5)
),
agg10 AS (
  SELECT
    AVG(profit_margin) AS avg_profit_margin_10yr,
    EXP((LN(MAX(revenue)) - LN(MIN(revenue)))/10) - 1 AS cagr_revenue_10yr,
    EXP((LN(MAX(book_value)) - LN(MIN(book_value)))/10) - 1 AS cagr_book_10yr
  FROM hist_fy
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
latest_quote AS (
  SELECT symbol, close AS current_price,
         ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
  FROM shibui.stock_quotes
  WHERE ticker = '${ticker}'
),
revenue_growth_calc AS (
  SELECT
    f.year,
    ROUND((f.revenue - LAG(f.revenue) OVER (ORDER BY f.year)) 
          / NULLIF(LAG(f.revenue) OVER (ORDER BY f.year),0),4) AS revenue_growth
  FROM shibui.fundamentals_yearly f
  WHERE f.ticker = '${ticker}'
),
ratios AS (
  SELECT
    f.year,
    ROUND(AVG(f.net_income / NULLIF(f.equity,0)),4) AS roic,
    ROUND(AVG(v.market_cap / NULLIF(f.net_income,0)),4) AS pe,
    ROUND(AVG(v.market_cap / NULLIF(f.free_cash_flow,0)),4) AS pfcf,
    ROUND(AVG(f.profit_margin),4) AS profit_margin,
    ROUND(AVG(f.free_cash_flow / NULLIF(f.revenue,0)),4) AS fcf_margin,
    AVG(f.shares_outstanding) AS shares,
    AVG(f.free_cash_flow) AS fcf,
    MAX(rgc.revenue_growth) AS revenue_growth   -- bring in the precomputed growth
  FROM shibui.fundamentals_yearly f
  LEFT JOIN shibui.valuation v
    ON v.symbol = f.symbol AND EXTRACT(YEAR FROM v.date) = f.year
  LEFT JOIN revenue_growth_calc rgc ON rgc.year = f.year
  WHERE f.ticker = '${ticker}'
  GROUP BY f.year
  ORDER BY f.year DESC
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
  g.type AS asset_type,
  g.reporting_currency AS currency,
  g.country_name AS country,
  g.gics_sector AS sector,
  g.gics_industry AS industry,
  g.description,
  v.market_cap, v.enterprise_value, v.price_to_book,
  dd.free_cash_flow_yield, dd.trailing_pe, dd.operating_pe, dd.dividend_yield,
  ttm.ttm_revenue, ttm.ttm_net_income, ttm.ttm_fcf, ttm.ttm_margin, ttm.fcf_margin_ttm,
  fy.revenue AS revenue_annual, fy.free_cash_flow AS free_cash_flow_annual, fy.profit_margin AS profit_margin_annual, fy.year,
  agg5.avg_net_income_5yr, agg5.avg_fcf_5yr, agg5.avg_profit_margin_5yr, agg5.cagr_revenue_5yr, agg5.cagr_book_5yr,
  agg10.avg_profit_margin_10yr, agg10.cagr_revenue_10yr, agg10.cagr_book_10yr,
  (v.enterprise_value / NULLIF(ttm.ttm_net_income,0)) AS ev_earnings,
  (v.enterprise_value / NULLIF(ttm.ttm_fcf,0)) AS ev_fcf,
  (ttm.ttm_net_income / NULLIF(fy.equity,0)) AS roe,
  (ttm.ttm_net_income / NULLIF(fy.total_assets,0)) AS roa,
  tech.sma_20, tech.sma_50, tech.sma_200, tech.rsi_14,
  h.wk52_high, h.wk52_low,
  q.current_price,
  rf.form_type, rf.filing_date, rf.report_date, rf.filing_url, rf.accession_number,
  -- Analyst estimates
  ae.forward_pe,
  ae.forward_pe_next_year,
  ae.forward_peg,
  ae.wall_street_target_price,
  -- Latest values
  (SELECT revenue FROM hist_fy ORDER BY year DESC LIMIT 1) AS latestRevenue,
  (SELECT shares_outstanding FROM hist_fy ORDER BY year DESC LIMIT 1) AS latestShares,
  (SELECT free_cash_flow FROM hist_fy ORDER BY year DESC LIMIT 1) AS latestFCF,
  (SELECT net_income FROM hist_fy ORDER BY year DESC LIMIT 1) AS latestNetIncome,
  -- TTM ratios
  dd.trailing_pe AS ttmPE,
  (v.enterprise_value / NULLIF(ttm.ttm_fcf,0)) AS ttmPFCF,
  ttm.ttm_margin AS ttmProfitMargin,
  ttm.fcf_margin_ttm AS ttmFCFMargin,
  agg5.cagr_revenue_5yr AS ttmRevenueGrowth,
  (ttm.ttm_net_income / NULLIF(fy.equity,0)) AS ttmROIC,
  -- Historical arrays (DuckDB syntax)
  (SELECT json_group_array(json_object('year', year, 'value', roic)) FROM ratios) AS roic,
  (SELECT json_group_array(json_object('year', year, 'value', pe)) FROM ratios) AS pe,
  (SELECT json_group_array(json_object('year', year, 'value', pfcf)) FROM ratios) AS pfcf,
  (SELECT json_group_array(json_object('year', year, 'value', profit_margin)) FROM ratios) AS profitMargin,
  (SELECT json_group_array(json_object('year', year, 'value', fcf_margin)) FROM ratios) AS fcfMargin,
  (SELECT json_group_array(json_object('year', year, 'value', revenue_growth)) FROM ratios) AS revenueGrowth,
  (SELECT json_group_array(json_object('year', year, 'value', shares)) FROM ratios) AS shares,
  (SELECT json_group_array(json_object('year', year, 'value', fcf)) FROM ratios) AS fcf
FROM shibui.general_info g
LEFT JOIN (SELECT * FROM latest_val WHERE rn = 1) v ON v.symbol = g.symbol
LEFT JOIN (SELECT * FROM latest_dd WHERE rn = 1) dd ON dd.symbol = g.symbol
LEFT JOIN ttm ON ttm.symbol = g.symbol
LEFT JOIN (SELECT * FROM latest_fy WHERE rn = 1) fy ON fy.symbol = g.symbol
LEFT JOIN agg5 ON g.symbol IS NOT NULL
LEFT JOIN agg10 ON g.symbol IS NOT NULL
LEFT JOIN (SELECT * FROM latest_tech WHERE rn = 1) tech ON tech.symbol = g.symbol
LEFT JOIN (SELECT * FROM hi52 WHERE rn = 1) h ON h.symbol = g.symbol
LEFT JOIN (SELECT * FROM latest_quote WHERE rn = 1) q ON q.symbol = g.symbol
LEFT JOIN (SELECT * FROM recent_filings WHERE rn = 1) rf ON rf.accession_number IS NOT NULL
LEFT JOIN shibui.analyst_estimates ae ON ae.symbol = g.symbol
WHERE g.ticker = '${ticker}'
LIMIT 1;


`.trim();

    const response = await callTool('stock_data_query', {
      user_prompt: `${ticker} full snapshot`,
      query: sql
    }, 1003);

res.json({
  ticker: ticker,
  response
});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Start server ---
app.listen(3000, () => console.log('API running locally on port 3000'));


