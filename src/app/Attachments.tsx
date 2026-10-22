// Pièces jointes : lecture (fichier, presse-papier, glisser-déposer), miniatures, aperçu.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { isModelReadable } from '../shared/client.ts';
import type { Attachment } from '../shared/schemas.ts';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gdk.Clipboard.prototype, 'read_texture_async', 'read_texture_finish');
Gio._promisify(Gdk.Clipboard.prototype, 'read_value_async', 'read_value_finish');
Gio._promisify(Gtk.FileDialog.prototype, 'open_multiple', 'open_multiple_finish');
Gio._promisify(Gtk.FileLauncher.prototype, 'launch', 'launch_finish');

/** Taille maximale d'une pièce jointe envoyée en base64. */
export const MAX_ATTACHMENT = 20 * 1024 * 1024;

export const isImage = (mime: string | undefined): boolean => mime?.startsWith('image/') === true;

const dataUrl = (mime: string, bytes: Uint8Array): string => `data:${mime};base64,${GLib.base64_encode(bytes)}`;

/** Contenu d'une URL `data:…;base64,` (null si autre forme). */
function decodeDataUrl(url: string): Uint8Array | null {
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || comma === -1 || !url.slice(0, comma).endsWith(';base64')) return null;
  return GLib.base64_decode(url.slice(comma + 1));
}

/** Pièce jointe depuis un fichier local : images en base64, autres fichiers par chemin (`file://`). */
export async function attachmentFromFile(file: Gio.File): Promise<Attachment> {
  const info = await file.query_info_async('standard::content-type,standard::display-name,standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
  const mime = Gio.content_type_get_mime_type(info.get_content_type() ?? '') ?? 'application/octet-stream';
  const filename = info.get_display_name();
  if (!isImage(mime)) return { mime, filename, url: file.get_uri() };
  if (info.get_size() > MAX_ATTACHMENT) throw new Error(`${filename} : image trop lourde (max ${MAX_ATTACHMENT / 1024 / 1024} Mo)`);
  const [bytes] = await file.load_contents_async(null);
  return { mime, filename, url: dataUrl(mime, bytes) };
}

/** Pièce jointe depuis une image (presse-papier, glisser-déposer). */
export function attachmentFromTexture(texture: Gdk.Texture, filename = 'image.png'): Attachment {
  const png = texture.save_to_png_bytes().get_data() ?? new Uint8Array();
  return { mime: 'image/png', filename, url: dataUrl('image/png', png) };
}

/** Lit le presse-papier : image ou fichiers. null si le contenu est du texte (collage normal). */
export async function attachmentsFromClipboard(clipboard: Gdk.Clipboard): Promise<Attachment[] | null> {
  const formats = clipboard.get_formats();
  if (formats.contain_gtype(Gdk.FileList.$gtype)) {
    const value: unknown = await clipboard.read_value_async(Gdk.FileList.$gtype, GLib.PRIORITY_DEFAULT, null);
    if (value instanceof Gdk.FileList) return Promise.all(value.get_files().map((f) => attachmentFromFile(f)));
  }
  if (formats.contain_gtype(Gdk.Texture.$gtype)) {
    const texture = await clipboard.read_texture_async(null);
    return texture === null ? null : [attachmentFromTexture(texture, 'clipboard.png')];
  }
  return null;
}

/** Ouvre le sélecteur de fichiers. */
export async function pickFiles(parent: Gtk.Widget): Promise<Attachment[]> {
  const root = parent.get_root();
  const dialog = new Gtk.FileDialog({ title: 'Joindre des fichiers', modal: true });
  const files = await dialog.open_multiple(root instanceof Gtk.Window ? root : null, null).catch(() => null); // annulé
  if (files === null) return [];
  const list: Gio.File[] = [];
  for (let i = 0; i < files.get_n_items(); i += 1) {
    const f = files.get_item(i);
    if (f instanceof Gio.File) list.push(f);
  }
  return Promise.all(list.map((f) => attachmentFromFile(f)));
}

// ---------------------------------------------------------------- affichage

/** Textures décodées, par URL (une image n'est décodée qu'une fois, à l'affichage). */
const textures = new Map<string, Gdk.Texture | null>();

export function textureOf(url: string): Gdk.Texture | null {
  const cached = textures.get(url);
  if (cached !== undefined) return cached;
  let texture: Gdk.Texture | null = null;
  try {
    const bytes = url.startsWith('file://') ? null : decodeDataUrl(url);
    texture = bytes === null ? Gdk.Texture.new_from_file(Gio.File.new_for_uri(url)) : Gdk.Texture.new_from_bytes(new GLib.Bytes(bytes));
  } catch {
    texture = null;
  }
  if (textures.size > 100) textures.clear();
  textures.set(url, texture);
  return texture;
}

/** Ouvre une pièce jointe avec l'application par défaut (les URL `data:` passent par un fichier temporaire). */
async function launch(parent: Gtk.Widget, a: { mime?: string | undefined; filename?: string | undefined; url: string }): Promise<void> {
  let file: Gio.File;
  const bytes = decodeDataUrl(a.url);
  if (bytes === null) {
    file = Gio.File.new_for_uri(a.url);
  } else {
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'opencode-gnome', 'attachments']);
    GLib.mkdir_with_parents(dir, 0o700);
    const ext = a.mime === undefined ? '' : (a.mime.split('/')[1]?.replaceAll(/[^\w]/gu, '') ?? '');
    const name = (a.filename ?? 'piece-jointe').replaceAll('/', '_');
    file = Gio.File.new_for_path(GLib.build_filenamev([dir, name.includes('.') || ext === '' ? name : `${name}.${ext}`]));
    await file.replace_contents_bytes_async(new GLib.Bytes(bytes), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
  }
  const root = parent.get_root();
  await new Gtk.FileLauncher({ file }).launch(root instanceof Gtk.Window ? root : null, null);
}

/** Aperçu d'une image dans un dialogue. */
export function openPreview(parent: Gtk.Widget, a: { mime?: string | undefined; filename?: string | undefined; url: string }): void {
  const texture = textureOf(a.url);
  if (texture === null) return;
  const dialog = new Adw.Dialog({
    title: a.filename ?? 'Image',
    contentWidth: Math.min(Math.max(texture.get_width(), 360), 1400),
    contentHeight: Math.min(texture.get_height() + 48, 1000),
  });
  const header = new Adw.HeaderBar();
  const open = new Gtk.Button({ iconName: 'document-open-symbolic', tooltipText: "Ouvrir avec l'application par défaut" });
  open.connect('clicked', () => {
    launch(parent, a).catch((e: unknown) => console.error(e));
  });
  header.pack_start(open);
  const view = new Adw.ToolbarView({ content: new Gtk.Picture({ paintable: texture, contentFit: Gtk.ContentFit.CONTAIN, canShrink: true }) });
  view.add_top_bar(header);
  dialog.child = view;
  dialog.present(parent);
}

const THUMB_HEIGHT = 120;
const THUMB_MAX_WIDTH = 240;

/** Miniature cliquable (aperçu) d'une image, ou puce cliquable (ouverture) d'un autre fichier. */
export function AttachmentView({ mime, filename, url, onRemove }: { mime?: string | undefined; filename?: string | undefined; url: string; onRemove?: () => void }): JSX.Element {
  const texture = isImage(mime) ? textureOf(url) : null;
  let content: JSX.Element;
  if (texture === null) {
    const icon = Gio.content_type_get_symbolic_icon(Gio.content_type_from_mime_type(mime ?? '') ?? '');
    content = (
      <Gtk.Button
        cssClasses={['attachment-chip']}
        tooltipText={onRemove !== undefined && !isModelReadable(mime ?? '') ? `${filename ?? ''} : type non lisible par le modèle, transmis par son chemin` : (filename ?? '')}
        onClicked={(self: Gtk.Button) => {
          launch(self, { mime, filename, url }).catch((e: unknown) => console.error(e));
        }}
      >
        <Gtk.Box spacing={6}>
          <Gtk.Image gicon={icon} />
          <Gtk.Label label={filename ?? mime ?? 'fichier'} ellipsize={Pango.EllipsizeMode.MIDDLE} maxWidthChars={30} />
        </Gtk.Box>
      </Gtk.Button>
    );
  } else {
    const ratio = texture.get_width() / Math.max(1, texture.get_height());
    const width = Math.round(Math.min(THUMB_MAX_WIDTH, THUMB_HEIGHT * ratio));
    content = (
      <Gtk.Button cssClasses={['attachment-thumb']} halign={Gtk.Align.START} valign={Gtk.Align.START} tooltipText={filename ?? ''} onClicked={(self: Gtk.Button) => openPreview(self, { mime, filename, url })}>
        {/* Gtk.Picture demande la taille de l'image : les Clamp la plafonnent (largeur puis hauteur) */}
        <Adw.Clamp orientation={Gtk.Orientation.VERTICAL} maximumSize={THUMB_HEIGHT} tighteningThreshold={THUMB_HEIGHT}>
          <Adw.Clamp maximumSize={width} tighteningThreshold={width}>
            <Gtk.Picture paintable={texture} contentFit={Gtk.ContentFit.COVER} canShrink widthRequest={width} heightRequest={THUMB_HEIGHT} />
          </Adw.Clamp>
        </Adw.Clamp>
      </Gtk.Button>
    );
  }
  if (onRemove === undefined) return content;
  return (
    <Gtk.Overlay cssClasses={['removable']} child={content instanceof Gtk.Widget ? content : null}>
      <Gtk.Button
        $type="overlay"
        iconName="window-close-symbolic"
        tooltipText="Retirer"
        halign={Gtk.Align.END}
        valign={Gtk.Align.START}
        cssClasses={['circular', 'osd', 'attachment-remove']}
        onClicked={onRemove}
      />
    </Gtk.Overlay>
  );
}
