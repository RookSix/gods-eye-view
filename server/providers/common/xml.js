const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

/** Decode the five XML entities and numeric references; anything else is left as written. */
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|</y;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const localName = (name) => name.slice(name.indexOf(':') + 1);

/**
 * Small dependency-free XML reader for trusted-shape upstream feeds. It builds
 * `{name, attrs, children, text}` nodes, never resolves DTDs or external
 * entities, ignores comments, processing instructions and doctypes, and bounds
 * node count and depth so a hostile body cannot exhaust memory.
 *
 * @param {string} source Document text.
 * @param {{maxNodes?:number, maxDepth?:number}} [limits]
 * @returns {{name:string, attrs:object, children:Array<object>, text:string}}
 *   The document element.
 */
export function parseXml(source, { maxNodes = 60_000, maxDepth = 40 } = {}) {
  const text = String(source ?? '');
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let nodes = 0;
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const match = TOKEN.exec(text);
    if (!match) break;
    const [, cdata, closing, opening, attributes, selfClosing, chars] = match;
    const top = stack[stack.length - 1];
    if (cdata !== undefined) {
      top.text += cdata;
    } else if (chars !== undefined) {
      top.text += decodeEntities(chars);
    } else if (closing !== undefined) {
      const name = localName(closing);
      const at = stack.findLastIndex((node) => node.name === name);
      if (at > 0) stack.length = at;
    } else if (opening !== undefined) {
      if (++nodes > maxNodes) throw new Error('xml_too_many_nodes');
      const attrs = {};
      for (const attr of (attributes || '').matchAll(ATTRIBUTE))
        attrs[localName(attr[1])] = decodeEntities(attr[2] ?? attr[3] ?? '');
      const node = {
        name: localName(opening),
        attrs,
        children: [],
        text: '',
      };
      top.children.push(node);
      if (!selfClosing) {
        if (stack.length > maxDepth) throw new Error('xml_too_deep');
        stack.push(node);
      }
    }
  }
  const element = root.children[0];
  if (!element) throw new Error('xml_empty');
  return element;
}

/** First direct child with this element name, or null. */
export function child(node, name) {
  return node?.children.find((entry) => entry.name === name) ?? null;
}

/** All direct children with this element name. */
export function childrenNamed(node, name) {
  return node ? node.children.filter((entry) => entry.name === name) : [];
}

/** First descendant (depth first) with this element name, or null. */
export function findDescendant(node, name) {
  if (!node) return null;
  for (const entry of node.children) {
    if (entry.name === name) return entry;
    const found = findDescendant(entry, name);
    if (found) return found;
  }
  return null;
}

/** Trimmed text of a node, or '' for a missing one. */
export function textOf(node) {
  return node ? node.text.trim() : '';
}
