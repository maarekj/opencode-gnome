// Paramètres des outils MCP, aplatis depuis leur schéma JSON.
import { toolParams } from '../src/shared/mcp.ts';

describe('toolParams', () => {
  it('liste les paramètres : type, requis, description, défaut', () => {
    const params = toolParams({
      name: 'search',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Texte cherché' },
          limit: { type: 'integer', default: 10 },
          tags: { type: 'array', items: { type: 'string' } },
          mode: { enum: ['exact', 'fuzzy'] },
          id: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        },
        required: ['query'],
      },
    });
    expect(params).toEqual([
      { name: 'query', type: 'string', required: true, description: 'Texte cherché' },
      { name: 'limit', type: 'integer', required: false, description: 'défaut : 10' },
      { name: 'tags', type: 'string[]', required: false, description: '' },
      { name: 'mode', type: '"exact" | "fuzzy"', required: false, description: '' },
      { name: 'id', type: 'string | number', required: false, description: '' },
    ]);
  });

  it('outil sans schéma ni propriétés', () => {
    expect(toolParams({ name: 'ping' })).toEqual([]);
    expect(toolParams({ name: 'ping', inputSchema: { type: 'object' } })).toEqual([]);
  });
});
