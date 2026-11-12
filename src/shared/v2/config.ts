// Serveurs MCP déclarés dans les fichiers de configuration d'opencode (#174) : l'API d'OpenCode 2
// ne renvoie que leur nom et leur état. Formats v1 (`mcp.<nom>`, `enabled`) et v2
// (`mcp.servers.<nom>`, `disabled`) ; JSONC (commentaires, virgules finales) accepté.
import GLib from 'gi://GLib';
import * as z from 'zod/mini';
import type { McpConfig } from '../schemas.ts';

const Obj = z.record(z.string(), z.unknown());
/** Objet JSON (pas un tableau), sinon null. */
const record = (v: unknown): Record<string, unknown> | null => (Array.isArray(v) ? null : (Obj.safeParse(v).data ?? null));

/** JSONC → JSON : commentaires et virgules finales retirés (hors chaînes). */
export function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] ?? '';
    if (c === '"') {
      const start = i;
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === '\\') i += 1;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i += 1;
    } else out += c;
  }
  return out.replaceAll(/,(\s*[}\]])/gu, '$1');
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok) return null;
    return record(JSON.parse(stripJsonc(new TextDecoder().decode(bytes))));
  } catch {
    return null;
  }
}

const strings = (v: unknown): Record<string, string> | undefined =>
  typeof v === 'object' && v !== null ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string')) : undefined;

/** Déclaration v1 ou v2 → forme de l'application. */
function server(v: unknown): McpConfig | null {
  const o = record(v);
  if (o === null) return null;
  const command = Array.isArray(o['command']) ? o['command'].filter((x): x is string => typeof x === 'string') : undefined;
  const environment = strings(o['environment']);
  const headers = strings(o['headers']);
  const enabled = typeof o['disabled'] === 'boolean' ? !o['disabled'] : typeof o['enabled'] === 'boolean' ? o['enabled'] : undefined;
  return {
    ...(typeof o['type'] === 'string' ? { type: o['type'] } : {}),
    ...(command === undefined ? {} : { command }),
    ...(typeof o['url'] === 'string' ? { url: o['url'] } : {}),
    ...(enabled === undefined ? {} : { enabled }),
    ...(environment === undefined ? {} : { environment }),
    ...(headers === undefined ? {} : { headers }),
  };
}

/** Serveurs MCP d'un objet de configuration. */
export function mcpOf(config: Record<string, unknown> | null): Record<string, McpConfig> {
  const m = record(config?.['mcp']);
  if (m === null) return {};
  // v2 : `servers` ; v1 : serveurs au premier niveau (les deux peuvent coexister)
  const entries = [...Object.entries(m).filter(([k]) => k !== 'servers' && k !== 'timeout'), ...Object.entries(record(m['servers']) ?? {})];
  const out: Record<string, McpConfig> = {};
  for (const [name, v] of entries) {
    const s = server(v);
    if (s !== null) out[name] = s;
  }
  return out;
}

const FILES = ['opencode.json', 'opencode.jsonc'];

/** Serveurs MCP déclarés : globaux, plus ceux du projet `directory` s'il est donné (le projet l'emporte). */
export function declaredMcp(directory: string | null): Record<string, McpConfig> {
  const global = GLib.build_filenamev([GLib.get_user_config_dir(), 'opencode']);
  const dirs = [global, ...(directory === null ? [] : [directory, GLib.build_filenamev([directory, '.opencode'])])];
  const out: Record<string, McpConfig> = {};
  for (const d of dirs) for (const f of FILES) Object.assign(out, mcpOf(readJson(GLib.build_filenamev([d, f]))));
  return out;
}
