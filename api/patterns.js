const MCP_URL = 'https://mcp.shibui.finance/mcp';

async function parseSSE(response) {
  const text = await response.text();
  const lines = text.split("\n");
  const dataLine = lines.find(line => line.startsWith("data:"));
  if (dataLine) {
    const jsonStr = dataLine.replace("data: ", "");
    try { return JSON.parse(jsonStr); } catch { return { error: "Parse error", raw: jsonStr }; }
  }
  return { error: "No data line found", raw: text };
}

async function callTool(name, args = {}, id = 1) {
  const resp = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
  });
  return await parseSSE(resp);
}

export default async function handler(req, res) {
  try {
    const parsed = await callTool('get_query_patterns', {}, 110);
    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
