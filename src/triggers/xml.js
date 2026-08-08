/**
 * A minimal XML → plain-object reader, sized for exactly one job: the XML that .NET's
 * `XmlSerializer` writes, which is what a GINA package contains.
 *
 * That narrowness is the whole justification for not taking a dependency. The documents
 * have no namespaces, no attributes on any element that carries data, no DTDs and no
 * processing instructions beyond the declaration — the schema is fixed and known. What
 * they DO have, all measured against the committed fixtures:
 *
 *   - **XML entities in load-bearing positions.** Patterns are stored as
 *     `(?&lt;player&gt;.*)`. Skip the decoding and you do not get an ugly regex, you get
 *     a broken one — `(?&lt;player&gt;.*)` compiles to something matching literal text.
 *   - **UTF-16 with a BOM**, from some versions of the serializer. Note that this is the
 *     opposite trap to the eqlogs, which are latin1 and never utf8; a `.gtp` states its
 *     encoding and must be believed.
 *   - **Repeated sibling elements**, which have to collapse to arrays. `TimerEarlyEnders`
 *     appears twice in a single real trigger — once self-closing and empty, once with
 *     content — so a reader that let the last one win would silently drop 68 early
 *     enders from the RespawnTimer pack.
 *   - **CDATA**, comments and self-closing tags.
 *
 * The shape produced is deliberately dumb: every element becomes either a string (leaf)
 * or an object (has children), and repeats become arrays. `gina.js` does the knowing.
 */

export class XmlError extends Error {}

/**
 * Decode a package's bytes to text, honouring the BOM and the XML declaration.
 *
 * Order matters: a BOM is authoritative and comes first, because a UTF-16 document
 * decoded as UTF-8 turns its own `encoding=` declaration into unreadable bytes — so
 * sniffing the declaration out of a mis-decoded string cannot be the first step.
 *
 * @param {Buffer|string} input
 * @returns {string}
 */
export function decodeXml(input) {
  if (typeof input === 'string') return stripBom(input);
  if (!Buffer.isBuffer(input)) throw new XmlError('expected a buffer or string');

  if (input.length >= 2 && input[0] === 0xff && input[1] === 0xfe) {
    return input.subarray(2).toString('utf16le');
  }
  if (input.length >= 2 && input[0] === 0xfe && input[1] === 0xff) {
    return swap16(input.subarray(2)).toString('utf16le');
  }
  if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    return input.subarray(3).toString('utf8');
  }

  // No BOM. A UTF-16 document without one still betrays itself: ASCII markup means every
  // other byte is zero, and `<` is the first character of any XML document.
  if (input.length >= 4 && input[0] === 0x3c && input[1] === 0x00) {
    return input.toString('utf16le');
  }

  const utf8 = input.toString('utf8');
  const declared = /^\s*<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i.exec(utf8)?.[1]?.toLowerCase();
  if (declared === 'utf-16' || declared === 'utf-16le' || declared === 'unicode') {
    return input.toString('utf16le');
  }
  // latin1 and windows-1252 differ only above 0x7f, where XML entities would normally be
  // used anyway; latin1 is the one Node has built in and is what these bytes are.
  if (declared === 'iso-8859-1' || declared === 'latin1' || declared === 'windows-1252') {
    return input.toString('latin1');
  }
  return utf8;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function swap16(buf) {
  const out = Buffer.from(buf);
  // A trailing odd byte cannot be half of a code unit; Buffer#swap16 rejects the whole
  // buffer over it, so it is dropped rather than allowed to fail the import.
  return out.subarray(0, out.length - (out.length % 2)).swap16();
}

/**
 * Parse XML into nested plain objects.
 *
 * @param {Buffer|string} input
 * @returns {{name: string, value: object|string}} the root element
 */
export function parseXml(input) {
  const text = decodeXml(input);
  const len = text.length;

  /** Open elements, innermost last. Each holds the children seen so far. */
  const stack = [{ name: '#document', children: Object.create(null), text: '' }];
  let i = 0;
  let root = null;

  while (i < len) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      stack[stack.length - 1].text += text.slice(i);
      break;
    }
    stack[stack.length - 1].text += text.slice(i, lt);

    // <!-- comment -->, <![CDATA[…]]>, <!DOCTYPE …>
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) throw new XmlError('unterminated comment');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end === -1) throw new XmlError('unterminated CDATA section');
      // CDATA is verbatim: entity decoding must NOT run over it, which is precisely
      // why the text is accumulated here rather than decoded in one pass at the end.
      stack[stack.length - 1].text += text.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', lt) || text.startsWith('<?', lt)) {
      const end = text.indexOf('>', lt);
      if (end === -1) throw new XmlError('unterminated declaration');
      i = end + 1;
      continue;
    }

    const gt = text.indexOf('>', lt);
    if (gt === -1) throw new XmlError('unterminated tag');
    const tag = text.slice(lt + 1, gt);
    i = gt + 1;

    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      const node = stack.pop();
      if (stack.length === 0) throw new XmlError(`unexpected closing tag </${name}>`);
      if (node.name !== name) {
        throw new XmlError(`closing tag </${name}> does not match <${node.name}>`);
      }
      const value = collapse(node);
      attach(stack[stack.length - 1], name, value);
      if (stack.length === 1) root = { name, value };
      continue;
    }

    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const name = body.split(/[\s\r\n\t]/, 1)[0];
    if (!name) throw new XmlError('empty tag name');

    if (selfClosing) {
      // `<TimerEarlyEnders />` is how the serializer writes an empty collection, and it
      // must read as empty-string rather than as absent — a caller distinguishing "no
      // early enders" from "the element was never there" would be splitting hairs the
      // format does not draw.
      attach(stack[stack.length - 1], name, '');
      if (stack.length === 1) root = { name, value: '' };
      continue;
    }
    stack.push({ name, children: Object.create(null), text: '' });
  }

  if (stack.length !== 1) {
    throw new XmlError(`unclosed element <${stack[stack.length - 1].name}>`);
  }
  if (!root) throw new XmlError('no root element');
  return root;
}

/**
 * An element with children is an object; one without is its decoded text.
 *
 * Mixed content — text alongside child elements — does not occur in this schema, and
 * the text is dropped rather than invented a home for.
 */
function collapse(node) {
  const keys = Object.keys(node.children);
  if (keys.length === 0) return decodeEntities(node.text);
  return node.children;
}

/** Second occurrence of a name turns the slot into an array; later ones push. */
function attach(parent, name, value) {
  const existing = parent.children[name];
  if (existing === undefined) parent.children[name] = value;
  else if (Array.isArray(existing)) existing.push(value);
  else parent.children[name] = [existing, value];
}

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

/**
 * Decode XML entities, including numeric ones.
 *
 * Load-bearing rather than cosmetic: `(?&lt;mob&gt;.*)` is how every named capture group
 * in the corpus is stored, and leaving it encoded produces a regex that compiles fine
 * and never matches anything — the worst possible failure, since nothing reports an
 * error and the trigger simply appears dead.
 */
export function decodeEntities(text) {
  if (!text || !text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // An unpaired surrogate or an out-of-range code point would corrupt the string;
      // leaving the entity as written is the honest failure.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED[body.toLowerCase()];
    return named ?? whole;
  });
}

/**
 * Read a child as an array, whatever arity the document happened to use.
 *
 * Every repeated element in this schema is conceptually a list, and the reader cannot
 * know that a `Trigger` seen once is still a list — so callers say so here. Empty
 * strings (`<Triggers />`) and absent children both read as no items.
 */
export function asArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}
