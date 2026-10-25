// Faux serveur MCP (stdio, JSON-RPC ligne à ligne) pour « Voir les outils ».
import readline from 'node:readline';

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'notes', version: '1' } } });
  if (m.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        tools: [
          { name: 'search_notes', description: 'Recherche dans les notes.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Texte cherché' }, limit: { type: 'integer', default: 10 } }, required: ['query'] } },
          { name: 'ping', description: 'Répond pong.', inputSchema: { type: 'object', properties: {} } },
        ],
      },
    });
  }
});
