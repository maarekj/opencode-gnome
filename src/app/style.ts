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
`;
