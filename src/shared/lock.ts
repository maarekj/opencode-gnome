// Verrou de fichier inter-processus (application, CLI ocg, runs des tâches).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** Exécute `fn` sous le verrou du fichier `path` (`path.lock` créé en exclusif ; périmé après 10 s). */
export function withLock(path: string, fn: () => void): void {
  const lock = Gio.File.new_for_path(`${path}.lock`);
  GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      lock.create(Gio.FileCreateFlags.NONE, null).close(null);
      break;
    } catch {
      let age = 0;
      try {
        age = Date.now() / 1000 - (lock.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null).get_modification_date_time()?.to_unix() ?? 0);
      } catch {
        continue; // verrou retiré entre-temps : nouvel essai
      }
      if (age > 10 || Date.now() > deadline) {
        try {
          lock.delete(null);
        } catch {
          // retiré par un autre processus
        }
        continue;
      }
      GLib.usleep(20_000);
    }
  }
  try {
    fn();
  } finally {
    try {
      lock.delete(null);
    } catch {
      // déjà retiré
    }
  }
}
