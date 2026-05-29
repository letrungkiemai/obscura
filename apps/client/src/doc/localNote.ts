import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';

export interface LocalNote {
  doc: Y.Doc;
  fragment: Y.XmlFragment;
  persistence: IndexeddbPersistence;
}

// BlockNote binds its editor to a named XML fragment. The same name must be used
// everywhere a given note is opened so the CRDT state lines up.
const FRAGMENT_NAME = 'document-store';

/**
 * Create a Yjs-backed note persisted to the browser's IndexedDB.
 *
 * The Y.Doc is the CRDT; IndexeddbPersistence transparently loads any saved
 * state on open and writes every update back — so edits survive reloads with no
 * server involvement. `dbKey` namespaces the IndexedDB store (e.g. per user).
 */
export function createLocalNote(dbKey: string): LocalNote {
  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(dbKey, doc);
  const fragment = doc.getXmlFragment(FRAGMENT_NAME);
  return { doc, fragment, persistence };
}
