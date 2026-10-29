// Test-only MCP server. It binds to loopback on an ephemeral port.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod';

const app = createMcpExpressApp({ host: '127.0.0.1' });
app.post('/mcp', async (req, res) => {
  const server = new McpServer({ name: 'knowledge-test', version: '1.0.0' });
  server.registerTool('search_documents', { description: 'Search test documents', inputSchema: { query: z.string() } }, async ({ query }) => ({ content: [{ type: 'text', text: `found: ${query}` }] }));
  server.registerResource('test-doc', 'test://document', { mimeType: 'text/plain' }, async () => ({ contents: [{ uri: 'test://document', text: 'fixture' }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  res.on('close', () => { void transport.close(); void server.close(); });
});
app.get('/mcp', (_req, res) => res.status(405).end());
app.delete('/mcp', (_req, res) => res.status(405).end());
const server = app.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') process.exit(1);
  console.log(address.port);
});
