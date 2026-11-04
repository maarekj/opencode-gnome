// #164 : une ligne de liste dont « non lu » / « dernière » changent garde la classe `activatable`
// ajoutée par GTK (survol du thème).
import Gtk from 'gi://Gtk?version=4.0';
import { createRoot, createState } from 'gnim';
import { bindClasses } from '../src/app/CssClass.ts';

Gtk.init();
const errors: string[] = [];
const list = new Gtk.ListBox({ cssClasses: ['navigation-sidebar'] });
const row = new Gtk.ListBoxRow({ cssClasses: ['session-tree-row'], child: new Gtk.Label({ label: 'session' }) });
list.append(row);
const [state, setState] = createState({ unread: false, last: false });
createRoot(() => bindClasses(row, state, (s) => ({ unread: s.unread, last: s.last })));
const has = (c: string): boolean => row.has_css_class(c);
if (!has('activatable')) errors.push('activatable absent au départ');
setState({ unread: true, last: true });
if (!has('unread') || !has('last')) errors.push('classes non ajoutées');
setState({ unread: false, last: true });
if (has('unread') || !has('last')) errors.push('unread non retirée');
if (!has('activatable') || !has('session-tree-row')) errors.push(`classes perdues : ${row.get_css_classes().join(' ')}`);
print(errors.length === 0 ? 'TEST OK' : errors.join('\n'));
