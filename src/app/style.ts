// Feuille de style de l'application (chargée au démarrage).
export const STYLESHEET = `
.user-message {
  background: alpha(var(--accent-bg-color), 0.10);
  border-radius: 12px;
  padding: 10px 14px;
}
.assistant-message {
  padding: 0 4px;
}
.tool-call expander-widget > box > title,
.tool-call > expander > title {
  padding: 2px 0;
}
.tool-output {
  background: alpha(currentColor, 0.05);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 0.9em;
}
/* sortie dans un défilement horizontal : même taille que les sorties repliées à la largeur */
.tool-output-text {
  font-size: 0.9em;
}
.reasoning > title {
  opacity: 0.7;
}

.md-table {
  padding: 8px 12px;
}

.composer {
  padding: 0;
}
.composer-text {
  background: transparent;
}
.subagent-card {
  padding: 0;
}
.subagent-head {
  padding: 8px 12px;
  border-radius: 12px;
}
.subagent-report {
  margin: 0 12px 10px 12px;
}
.completion > contents {
  padding: 4px;
}
.completion-list {
  background: transparent;
}
.completion-list > row {
  border-radius: 6px;
}
.completion-badge {
  background: alpha(currentColor, 0.1);
  border-radius: 999px;
  padding: 0 8px;
}
.request {
  padding: 12px 14px;
}
.diff {
  padding: 8px 12px;
  font-size: 0.9em;
}

.request.question,
.request.permission {
  border: 1px solid alpha(var(--accent-bg-color), 0.5);
}
.other-answer {
  padding: 2px 6px;
  font-weight: normal;
  color: var(--accent-color);
}
.pending-pill {
  box-shadow: 0 2px 8px alpha(black, 0.25);
}

.waiting-badge {
  background: var(--warning-bg-color);
  color: var(--warning-fg-color);
  border-radius: 999px;
  min-width: 20px;
  padding: 0 6px;
  font-weight: bold;
  font-size: 0.85em;
}

.attachment-thumb {
  padding: 0;
  border-radius: 8px;
}
.attachment-chip {
  padding: 4px 10px;
}
.removable .attachment-chip {
  padding-right: 32px;
}
.attachment-remove {
  margin: 4px;
  min-width: 22px;
  min-height: 22px;
  padding: 0;
}
.message-attachment {
  margin-top: -6px;
}

.context-bar trough {
  min-height: 6px;
}
.context-bar block.filled {
  background: alpha(currentColor, 0.45);
}
.context-bar.warning block.filled {
  background: var(--warning-color);
}
.context-bar.error block.filled {
  background: var(--error-color);
}

.diff-view {
  font-size: 0.9em;
}
.git-pane-header {
  padding: 6px 12px;
  min-height: 36px;
}
/* journal : lignes jointives pour que le graphe des branches soit continu */
.git-log > row {
  margin: 0;
  padding: 0 6px 0 0;
  border-radius: 0;
}
.compare-bar {
  padding: 8px 12px;
}
.commit-info {
  padding: 12px 16px;
}
.commit-body {
  font-size: 0.9em;
}
.ref-badge {
  border-radius: 999px;
  padding: 0 7px;
  font-weight: bold;
}
.ref-head {
  background: var(--accent-bg-color);
  color: var(--accent-fg-color);
}
.ref-branch {
  background: alpha(var(--accent-color), 0.15);
  color: var(--accent-color);
}
.ref-remote {
  background: alpha(currentColor, 0.1);
}
.ref-tag {
  background: alpha(var(--warning-color), 0.2);
}
.diff-frame {
  border-radius: 6px;
  border: 1px solid alpha(currentColor, 0.1);
}
.diff-stat {
  font-family: monospace;
  opacity: 0.8;
}
.open-file {
  min-width: 24px;
  min-height: 24px;
  padding: 0;
}

.project-row .star:not(.favorite) {
  opacity: 0;
}
.project-row:hover .star,
.project-row .star:focus-visible {
  opacity: 1;
}
.project-row .star.favorite {
  color: var(--warning-color);
}

.markdown-view,
.markdown-view text {
  background: transparent;
}
.copyable .copy-button {
  opacity: 0;
  margin: -6px -6px 0 0;
}
.copyable:hover .copy-button,
.copyable .copy-button:focus-visible,
.copyable .copy-button.reading {
  opacity: 1;
}

/* dictée en cours : bouton micro rouge qui pulse */
@keyframes dictation-pulse {
  from { opacity: 1; }
  to { opacity: 0.45; }
}
.dictating {
  color: @error_color;
  animation: dictation-pulse 0.8s ease-in-out infinite alternate;
}

.todo-panel .todo-header {
  padding: 6px 12px;
  border-radius: 12px;
}
.todo-row.in_progress .heading {
  color: var(--accent-color);
}

.link-bar {
  padding: 4px 12px 6px 0;
}
.link-pill {
  background: alpha(var(--accent-bg-color), 0.10);
}
.link-browser {
  min-height: 26px;
}
.terminal-bar {
  padding: 4px 12px 6px 12px;
}
.terminal-pill {
  border-radius: 999px;
  padding: 2px 12px;
  min-height: 26px;
  font-size: 0.9em;
}
.terminal-pill.running {
  background: alpha(var(--accent-bg-color), 0.18);
  color: var(--accent-color);
}
.terminal-split > button {
  border-radius: 0;
  margin: 0;
}
.terminal-split > button:first-child {
  border-radius: 999px 0 0 999px;
}
.terminal-split > button:last-child {
  border-radius: 0 999px 999px 0;
}
.terminal-split > .terminal-action {
  padding: 2px 8px;
  min-width: 0;
}
.terminal-split > .terminal-stop:hover,
.terminal-tree-row .terminal-stop:hover {
  color: var(--error-color);
}
/* séparateur discret entre les parties du bouton divisé */
.terminal-split > button + button {
  border-left: 1px solid alpha(var(--accent-color), 0.25);
}
.terminal-dot {
  background: var(--success-color);
  border-radius: 999px;
  min-width: 7px;
  min-height: 7px;
}
/* message trouvé par la recherche : mis en évidence quelques secondes */
.search-hit {
  outline: 2px solid alpha(var(--accent-color), 0.7);
  outline-offset: 4px;
  border-radius: 8px;
}
.search-hit textview,
.search-hit textview text {
  background: alpha(var(--accent-bg-color), 0.12);
}
.search-results row.search-session {
  margin-top: 6px;
}
/* session non lue : point d'accent, titre en gras ; nombre de non lues sur le projet */
.unread-dot {
  background: var(--accent-bg-color);
  border-radius: 999px;
  min-width: 9px;
  min-height: 9px;
}
.unread .session-title,
row.unread .title {
  font-weight: bold;
}
.unread-badge {
  background: var(--accent-bg-color);
  color: var(--accent-fg-color);
  border-radius: 999px;
  min-width: 20px;
  padding: 0 6px;
  font-weight: bold;
  font-size: 0.85em;
}
.terminal-add {
  min-width: 26px;
  min-height: 26px;
  padding: 0;
}

.failure-dot {
  background: var(--error-bg-color);
  border-radius: 999px;
  min-width: 8px;
  min-height: 8px;
  margin: -2px -3px 0 0;
}

.diff-annotation {
  background: alpha(var(--accent-bg-color), 0.10);
  border-left: 3px solid var(--accent-bg-color);
  border-radius: 6px;
  padding: 6px 10px;
  margin: 4px 0 6px 0;
  font-family: sans-serif;
}
.review-comment {
  padding: 10px 12px;
}
.review-excerpt {
  background: alpha(currentColor, 0.05);
  border-radius: 6px;
  padding: 4px 8px;
}
.issue-post {
  padding: 12px 16px;
}

.stamp {
  font-size: 0.8em;
  margin: 0 4px;
}

.session-tree-row .close-button {
  opacity: 0;
  min-width: 22px;
  min-height: 22px;
  padding: 0;
}
.terminal-tree-row .terminal-dot {
  margin: 0 4px;
}
/* terminal : le point vert cède la place aux boutons au survol */
.terminal-tree-row:hover .terminal-dot,
.terminal-tree-row:selected .terminal-dot {
  opacity: 0;
}
.session-tree-row:hover .close-button,
.session-tree-row:selected .close-button,
.session-tree-row .close-button:focus-visible {
  opacity: 1;
}
.expander-button {
  min-width: 22px;
  min-height: 22px;
  padding: 0;
}

/* barre latérale : hiérarchie projet > sessions */
.project-row label.title {
  font-weight: bold;
}
/* un projet déplié est suivi de ses sessions : espace avant le projet suivant */
.session-tree-row.last {
  margin-bottom: 10px;
}
.project-row.expanded {
  margin-bottom: 0;
}
.session-tree-row {
  min-height: 30px;
  padding-top: 0;
  padding-bottom: 0;
}
/* ligne-guide verticale sous le dossier du projet */
.session-tree-inner {
  border-left: 1px solid alpha(currentColor, 0.18);
  padding-left: 12px;
}
.session-tree-row .session-title {
  font-size: 0.93em;
}

.sidebar-handle {
  background: transparent;
}
.sidebar-handle:hover {
  background: alpha(var(--accent-bg-color), 0.35);
}
/* terminal intégré : panneau à onglets sous la zone principale */
.terminal-panel tabbar .box {
  min-height: 34px;
}
.terminal-scroll vte-terminal {
  padding: 2px 4px;
}
.dragging {
  opacity: 0.4;
}
.drop-before {
  box-shadow: inset 3px 0 0 @accent_color;
}
.drop-after {
  box-shadow: inset -3px 0 0 @accent_color;
}
.drop-above {
  box-shadow: inset 0 3px 0 @accent_color;
}
.drop-below {
  box-shadow: inset 0 -3px 0 @accent_color;
}
.drop-into {
  box-shadow: inset 0 0 0 2px @accent_color;
}
/* dossier : bouton à menu, la pastille est son bouton interne */
menubutton.folder-pill {
  padding: 0;
  min-height: 0;
  background: none;
}
menubutton.folder-pill > button {
  border-radius: 999px;
  padding: 2px 12px;
  min-height: 26px;
  font-size: 0.9em;
  background: alpha(currentColor, 0.08);
}
menubutton.folder-pill > button:hover {
  background: alpha(currentColor, 0.14);
}
/* terminal en cours dans le dossier */
menubutton.folder-pill.running > button {
  background: alpha(var(--success-color), 0.20);
  box-shadow: inset 0 0 0 1px alpha(var(--success-color), 0.6);
}
.folder-row {
  border-radius: 8px;
}
.devenv-dot {
  border-radius: 999px;
  min-width: 8px;
  min-height: 8px;
}
.devenv-dot.devenv-ok {
  background: var(--success-color);
}
.devenv-dot.devenv-busy {
  background: var(--warning-color);
}
.devenv-dot.devenv-stopped {
  background: alpha(currentColor, 0.3);
}
.devenv-dot.devenv-failed {
  background: var(--error-color);
}
`;
