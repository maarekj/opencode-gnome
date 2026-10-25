// Dialogue « MCP, skills et plugins » : serveurs MCP (état, erreur, portée, connexion), skills et plugins,
// pour un projet ou en global (configuration globale seule, vue depuis le dossier personnel).
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import type { OpencodeClient } from '../shared/client.ts';
import { errorMessage } from '../shared/errors.ts';
import type { McpConfig, McpStatus, Skill } from '../shared/schemas.ts';
import { listMcpTools, toolParams, type McpTool } from '../shared/mcp.ts';
import { prettyPath } from '../shared/store.ts';
import { openFile } from './OpenFolder.ts';

const esc = (s: string): string => GLib.markup_escape_text(s, -1);

/** Libellé et classe CSS d'un état MCP. */
function statusInfo(s: McpStatus | undefined): { label: string; css: string } {
  switch (s?.status) {
    case 'connected':
      return { label: 'Connecté', css: 'success' };
    case 'failed':
      return { label: 'Échec', css: 'error' };
    case 'disabled':
      return { label: 'Désactivé', css: 'dim-label' };
    case 'needs_auth':
      return { label: 'Authentification requise', css: 'warning' };
    case 'needs_client_registration':
      return { label: 'Enregistrement requis', css: 'warning' };
    case undefined:
      return { label: 'Inconnu', css: 'dim-label' };
    default:
      return { label: s?.status ?? 'Inconnu', css: 'dim-label' };
  }
}

/** Provenance d'un skill, d'après l'emplacement de son SKILL.md. */
function skillOrigin(location: string, project: string | null): string {
  if (location === '<built-in>') return 'Intégrés à opencode';
  const home = GLib.get_home_dir();
  if (project !== null && location.startsWith(`${project}/`)) return 'Projet';
  if (location.startsWith(`${home}/.config/opencode/`)) return 'Globaux (~/.config/opencode)';
  if (location.startsWith(`${home}/.claude/`)) return 'Claude (~/.claude)';
  if (location.startsWith(`${home}/.agents/`)) return 'Agents (~/.agents)';
  return 'Autres';
}

const ORIGINS = ['Projet', 'Globaux (~/.config/opencode)', 'Claude (~/.claude)', 'Agents (~/.agents)', 'Autres', 'Intégrés à opencode'];

const placeholder = (text: string): Adw.ActionRow => new Adw.ActionRow({ title: esc(text), cssClasses: ['dim-label'] });

/** Ligne d'un skill : nom, description, ouverture du SKILL.md. */
function skillRow(s: Skill): Adw.ActionRow {
  const row = new Adw.ActionRow({ title: esc(s.name), subtitle: esc(s.description ?? ''), subtitleLines: 3, tooltipText: s.location === '<built-in>' ? '' : prettyPath(s.location) });
  if (s.location !== '<built-in>') {
    const open = new Gtk.Button({ iconName: 'document-open-symbolic', tooltipText: 'Ouvrir le SKILL.md', valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
    open.connect('clicked', () => openFile(open, s.location));
    row.add_suffix(open);
  }
  return row;
}

/** Plugin déclaré : nom, version ou chemin, options éventuelles. */
interface PluginInfo {
  readonly key: string;
  readonly name: string;
  readonly detail: string;
  /** fichier local (plugin découvert ou `file://`), ouvrable */
  readonly path: string | null;
  readonly options: string;
}

function pluginInfo(entry: unknown): PluginInfo | null {
  const tuple: readonly unknown[] = Array.isArray(entry) ? entry : [entry];
  const [spec, options] = tuple;
  if (typeof spec !== 'string') return null;
  const opts = options === undefined ? '' : JSON.stringify(options);
  if (spec.startsWith('file://') || spec.startsWith('/') || spec.startsWith('.')) {
    const path = spec.startsWith('file://') ? (GLib.filename_from_uri(spec)[0] ?? spec) : spec;
    return { key: spec, name: GLib.path_get_basename(path).replace(/\.[jt]s$/u, ''), detail: `fichier · ${prettyPath(path)}`, path: GLib.path_is_absolute(path) ? path : null, options: opts };
  }
  // paquet npm : nom@version (le nom peut commencer par @scope/)
  const at = spec.lastIndexOf('@');
  const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, ''];
  return { key: spec, name, detail: `npm${version === '' ? '' : ` · ${version}`}`, path: null, options: opts };
}

function pluginRow(p: PluginInfo, scope: string): Adw.ActionRow {
  const row = new Adw.ActionRow({ title: esc(p.name), subtitle: esc([scope, p.detail, p.options === '' ? '' : `options ${p.options}`].filter((x) => x !== '').join(' · ')), subtitleLines: 2, subtitleSelectable: true });
  if (p.path !== null) {
    const path = p.path;
    const open = new Gtk.Button({ iconName: 'document-open-symbolic', tooltipText: 'Ouvrir le fichier', valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
    open.connect('clicked', () => openFile(open, path));
    row.add_suffix(open);
  }
  return row;
}

/** Ligne d'un serveur MCP : état, portée, type ; détails (commande / URL, erreur) dépliables. */
function mcpRow(name: string, cfg: McpConfig | undefined, status: McpStatus | undefined, scope: string, onToggle: (connect: boolean) => void, onTools: () => void): Adw.ExpanderRow {
  const info = statusInfo(status);
  const kind = cfg?.type === 'remote' ? 'distant' : cfg?.type === 'local' ? 'local' : '';
  const row = new Adw.ExpanderRow({ title: esc(name), subtitle: esc([scope, kind].filter((x) => x !== '').join(' · ')) });
  const badge = new Gtk.Label({ label: info.label, valign: Gtk.Align.CENTER, cssClasses: ['caption-heading', info.css] });
  const connected = status?.status === 'connected';
  const toggle = new Gtk.Switch({ active: connected, valign: Gtk.Align.CENTER, tooltipText: connected ? 'Déconnecter' : 'Connecter' });
  toggle.connect('state-set', (_s: Gtk.Switch, state: boolean) => {
    toggle.sensitive = false;
    onToggle(state);
    return false;
  });
  // add_suffix d'Adw.ExpanderRow insère à gauche des suffixes existants
  row.add_suffix(toggle);
  row.add_suffix(badge);
  const detail = (title: string, value: string, css: string[] = []): void => {
    const r = new Adw.ActionRow({ title, subtitle: esc(value), subtitleSelectable: true, cssClasses: ['property', ...css] });
    row.add_row(r);
  };
  if (cfg?.url !== undefined) detail('URL', cfg.url);
  if (cfg?.command !== undefined) detail('Commande', cfg.command.join(' '));
  if (cfg?.enabled === false) detail('Configuration', 'désactivé (enabled: false)');
  if (status?.error !== undefined && status.error !== '') detail('Erreur', status.error, ['mcp-error']);
  if (cfg !== undefined && (cfg.command !== undefined || cfg.url !== undefined)) {
    const tools = new Adw.ActionRow({
      title: 'Outils',
      subtitle: cfg.type === 'remote' ? 'Interroge le serveur MCP directement' : 'Lance brièvement le serveur MCP pour lui demander ses outils',
      activatable: true,
    });
    const show = new Gtk.Button({ label: 'Voir les outils', valign: Gtk.Align.CENTER });
    show.connect('clicked', onTools);
    tools.add_suffix(show);
    tools.activatableWidget = show;
    row.add_row(tools);
  }
  return row;
}

/** Ligne d'un outil MCP : nom, description ; paramètres dépliables. */
function toolRow(tool: McpTool): Adw.PreferencesRow {
  const params = toolParams(tool);
  const description = (tool.description ?? '').trim();
  const firstLine = description.split('\n')[0] ?? '';
  const row = new Adw.ExpanderRow({
    title: esc(tool.title !== undefined && tool.title !== tool.name ? `${tool.name} — ${tool.title}` : tool.name),
    subtitle: esc(params.length === 0 ? firstLine : `${firstLine}${firstLine === '' ? '' : '\n'}${params.length} paramètre${params.length > 1 ? 's' : ''} : ${params.map((p) => p.name).join(', ')}`),
    subtitleLines: 3,
    cssClasses: ['mcp-tool'],
  });
  if (description !== '') {
    const label = new Gtk.Label({ label: description, xalign: 0, wrap: true, selectable: true, marginTop: 10, marginBottom: 10, marginStart: 12, marginEnd: 12 });
    row.add_row(label);
  }
  if (params.length === 0) {
    row.add_row(new Adw.ActionRow({ title: 'Aucun paramètre', cssClasses: ['dim-label'] }));
    return row;
  }
  for (const p of params) {
    const title = `<tt>${esc(p.name)}</tt>${p.type === '' ? '' : `  <span alpha="65%">${esc(p.type)}</span>`}${p.required ? '  <span foreground="#c01c28">requis</span>' : '  <span alpha="65%">facultatif</span>'}`;
    row.add_row(new Adw.ActionRow({ title, useMarkup: true, subtitle: esc(p.description), subtitleSelectable: true }));
  }
  return row;
}

/** Sous-page « outils d'un MCP » : chargement à la demande, liste filtrable par la recherche du dialogue. */
function toolsPage(name: string, cfg: McpConfig, directory: string): Adw.NavigationPage {
  const group = new Adw.PreferencesGroup({ title: 'Outils', description: 'Chargement…' });
  const spinner = new Adw.Spinner({ widthRequest: 32, heightRequest: 32, marginTop: 24 });
  group.add(spinner);
  const page = new Adw.PreferencesPage();
  page.add(group);
  const view = new Adw.ToolbarView({ content: page });
  view.add_top_bar(new Adw.HeaderBar({ titleWidget: new Adw.WindowTitle({ title: name, subtitle: 'Outils du serveur MCP' }) }));
  listMcpTools(cfg, directory)
    .then((tools) => {
      group.remove(spinner);
      group.description = tools.length === 0 ? 'Ce serveur MCP ne déclare aucun outil.' : `${tools.length} outil${tools.length > 1 ? 's' : ''} · clic : description complète et paramètres`;
      for (const t of tools.toSorted((a, b) => a.name.localeCompare(b.name))) group.add(toolRow(t));
      return tools;
    })
    .catch((e: unknown) => {
      group.remove(spinner);
      group.description = '';
      group.add(new Adw.ActionRow({ title: 'Impossible de lister les outils', subtitle: esc(errorMessage(e)), subtitleSelectable: true, cssClasses: ['mcp-error'] }));
    });
  return new Adw.NavigationPage({ title: `Outils de ${name}`, child: view });
}

/**
 * Ouvre le dialogue pour le projet `project` (chemin), ou en global (`null`).
 * Les données sont chargées à l'ouverture ; le bouton Recharger les relit.
 */
export function openExtensions(parent: Gtk.Widget, client: OpencodeClient, project: string | null): void {
  const directory = project ?? GLib.get_home_dir();
  const dialog = new Adw.PreferencesDialog({ title: project === null ? 'MCP, skills et plugins — global' : `MCP, skills et plugins — ${GLib.path_get_basename(project)}`, searchEnabled: true, contentWidth: 640, contentHeight: 640 });

  // ------------------------------------------------------------ MCP
  const mcpPage = new Adw.PreferencesPage({ title: 'MCP', iconName: 'network-server-symbolic' });
  const mcpGroup = new Adw.PreferencesGroup({
    title: 'Serveurs MCP',
    description: project === null ? 'Déclarés dans ~/.config/opencode/opencode.json' : `Configuration fusionnée de ${prettyPath(project)} (projet + global)`,
  });
  const reload = new Gtk.Button({ iconName: 'view-refresh-symbolic', tooltipText: 'Recharger', valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
  mcpGroup.headerSuffix = reload;
  mcpPage.add(mcpGroup);
  dialog.add(mcpPage);
  let mcpRows: Gtk.Widget[] = [];
  const setMcpRows = (rows: Gtk.Widget[]): void => {
    for (const r of mcpRows) mcpGroup.remove(r);
    mcpRows = rows;
    for (const r of rows) mcpGroup.add(r);
  };

  /** numéro du dernier chargement : les réponses des précédents sont ignorées (#92) */
  let mcpGeneration = 0;
  const loadMcp = async (): Promise<void> => {
    const gen = ++mcpGeneration;
    setMcpRows([placeholder('Chargement…')]);
    try {
      const [status, merged, global] = await Promise.all([client.mcpStatus(directory), client.mcpConfig(directory), client.mcpConfig(null)]);
      if (gen !== mcpGeneration) return;
      const names = [...new Set([...Object.keys(merged), ...Object.keys(status)])].toSorted((a, b) => a.localeCompare(b));
      if (names.length === 0) {
        setMcpRows([placeholder('Aucun serveur MCP')]);
        return;
      }
      setMcpRows(
        names.map((name) =>
          mcpRow(name, merged[name], status[name], project !== null && !(name in global) ? 'projet' : 'global', (connect) => {
            client
              .mcpConnect(name, directory, connect)
              .catch((e: unknown) => dialog.add_toast(new Adw.Toast({ title: esc(`${name} : ${errorMessage(e)}`), timeout: 5 })))
              .finally(() => void loadMcp());
          }, () => {
            const cfg = merged[name];
            if (cfg !== undefined) dialog.push_subpage(toolsPage(name, cfg, directory));
          }),
        ),
      );
    } catch (e) {
      if (gen === mcpGeneration) setMcpRows([placeholder(`Chargement impossible : ${errorMessage(e)}`)]);
    }
  };
  reload.connect('clicked', () => void loadMcp());

  // ------------------------------------------------------------ skills
  const skillPage = new Adw.PreferencesPage({ title: 'Skills', iconName: 'starred-symbolic' });
  dialog.add(skillPage);
  let skillGroups: Adw.PreferencesGroup[] = [];
  const setSkillGroups = (groups: Adw.PreferencesGroup[]): void => {
    for (const g of skillGroups) skillPage.remove(g);
    skillGroups = groups;
    for (const g of groups) skillPage.add(g);
  };
  const loadSkills = async (): Promise<void> => {
    try {
      const skills = await client.skills(directory);
      const byOrigin = Map.groupBy(skills, (s) => skillOrigin(s.location, project));
      const groups = ORIGINS.flatMap((origin) => {
        const list = byOrigin.get(origin);
        if (list === undefined) return [];
        const g = new Adw.PreferencesGroup({ title: `${origin} (${list.length})` });
        for (const s of list.toSorted((a, b) => a.name.localeCompare(b.name))) g.add(skillRow(s));
        return [g];
      });
      if (groups.length === 0) {
        const g = new Adw.PreferencesGroup();
        g.add(placeholder('Aucun skill'));
        groups.push(g);
      }
      setSkillGroups(groups);
    } catch (e) {
      const g = new Adw.PreferencesGroup();
      g.add(placeholder(`Chargement impossible : ${errorMessage(e)}`));
      setSkillGroups([g]);
    }
  };

  void loadMcp();
  void loadSkills();

  // ------------------------------------------------------------ plugins
  const pluginPage = new Adw.PreferencesPage({ title: 'Plugins', iconName: 'application-x-addon-symbolic' });
  const pluginGroup = new Adw.PreferencesGroup({
    title: 'Plugins',
    description: 'Déclarés dans opencode.json (« plugin ») ou découverts dans .opencode/plugin(s)/',
  });
  pluginPage.add(pluginGroup);
  dialog.add(pluginPage);
  const loadPlugins = async (): Promise<void> => {
    try {
      const [merged, global] = await Promise.all([client.plugins(project === null ? null : directory), client.plugins(null)]);
      const globalKeys = new Set(global.flatMap((e) => pluginInfo(e)?.key ?? []));
      const list = merged.flatMap((e) => pluginInfo(e) ?? []);
      if (list.length === 0) pluginGroup.add(placeholder('Aucun plugin'));
      for (const p of list) pluginGroup.add(pluginRow(p, project !== null && !globalKeys.has(p.key) ? 'projet' : 'global'));
    } catch (e) {
      pluginGroup.add(placeholder(`Chargement impossible : ${errorMessage(e)}`));
    }
  };
  void loadPlugins();
  dialog.present(parent);
}
