import * as Y from 'yjs';

/**
 * Flatten a BlockNote/Yjs XML fragment into plain text for indexing. Walks the
 * CRDT tree collecting Y.XmlText content, joining block-level elements with
 * spaces so words from adjacent blocks don't run together.
 */
export function xmlFragmentToText(node: Y.XmlFragment | Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) {
    return node.toString();
  }
  // Y.XmlFragment | Y.XmlElement — recurse over children.
  const parts: string[] = [];
  node.forEach((child) => {
    parts.push(xmlFragmentToText(child as Y.XmlFragment | Y.XmlElement | Y.XmlText));
  });
  return parts.join(' ');
}
