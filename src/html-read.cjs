/* How Dioptra reads a page a server sent (1.4.0-beta.8).
   The tags and attributes come from the HTML tokenizer of parse5, the one browsers' rules are written down in: it knows
   where a tag ends when an attribute holds a ">", decodes entities in addresses, ends comments the way a browser does
   and keeps the text of a script apart from markup. Only the tokenizer is used: the tree builder of parse5 takes minutes
   on a megabyte of nested tags, the tokenizer is linear.
   What the tokenizer leaves to the tree builder is done here in a small way: which elements hold raw text, and when the
   page is inside SVG or MathML, where those rules do not apply (a <style> inside <svg> is markup, and an <img> in it
   loads). That small tree builder can disagree with a browser (and browsers disagree with each other, as on <select>).
   So every piece that is read as text (raw text elements, comments, <![CDATA[) is read once more as markup, and what is
   found there is kept apart as "possible": a browser may still load it. Reading more is the safe direction.
   Everything is capped, and a cap that was reached is reported (cut), never silent. One clock covers the page and every
   piece read inside it. */
const { Tokenizer, TokenizerMode } = require('parse5');

const MAX_WALKED = 400000, MAX_ASSETS = 20000, MAX_INLINE = 2000, MAX_TAGS = 20000, MAX_CANDIDATES = 100, MAX_CSS_URLS = 1000, MAX_ATTRS = 500;
const MAX_SRCDOC = 512 * 1024, MAX_NESTING = 64, MAX_DEPTH = 3, CHUNK = 64 * 1024, READ_MS = 1000, MAX_RAW = 8 * 1024 * 1024;
const URL_ATTRS = ['src', 'href', 'srcset', 'action', 'poster', 'data-src', 'data-srcset'];
// Elements whose content is text, not markup, in HTML (not inside SVG or MathML). A browser reads title and textarea
// as RCDATA; the end is found the same way in RAWTEXT, and here the text keeps its entities, so that reading it again as
// markup sees what a browser that takes it for markup would see. The title is decoded on its own (decoded).
// <noscript> is text to a browser that runs scripts; what is inside is read as a page of its own, like an iframe's
// srcdoc: what a visitor without scripts would load is found for certain.
const RAW = { script: TokenizerMode.SCRIPT_DATA, style: TokenizerMode.RAWTEXT, xmp: TokenizerMode.RAWTEXT, iframe: TokenizerMode.RAWTEXT, noembed: TokenizerMode.RAWTEXT, noframes: TokenizerMode.RAWTEXT, noscript: TokenizerMode.RAWTEXT, title: TokenizerMode.RAWTEXT, textarea: TokenizerMode.RAWTEXT, plaintext: TokenizerMode.PLAINTEXT };
// A start tag of one of these inside SVG or MathML puts the browser back in HTML.
const BREAKOUT = new Set(['b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta', 'nobr', 'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var']);
// Inside these the content of SVG or MathML is HTML again (the element itself is not).
const ISLAND = { svg: new Set(['foreignobject', 'desc', 'title']), math: new Set(['mi', 'mo', 'mn', 'ms', 'mtext']) };
// A text could hold markup when it has a tag, an end tag, a comment or a <!...> in it.
const MARKUP = /<[a-zA-Z!?/]/;
// The types a browser runs as a script: none, "module", or a JavaScript MIME type (its essence, without parameters).
const JS_MIME = new Set(['application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript', 'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2', 'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript', 'text/x-ecmascript', 'text/x-javascript']);
function runsAsScript(a) {
  if (a.type === undefined) { const language = String(a.language || '').trim().toLowerCase(); return !language || JS_MIME.has(`text/${language}`); }
  const type = String(a.type).trim().toLowerCase();
  return !type || type === 'module' || JS_MIME.has(type.split(';')[0].trim());
}
function toURL(value, base) {
  try {
    const url = new URL(String(value).trim(), base);
    return /^https?:$/.test(url.protocol) && url.hostname ? url : null;
  } catch { return null; }
}

// CSS: the addresses in url(…), src(…), @import "…" and the strings of image-set(…). One pass over the text itself (no
// lower-cased copy, whose length can differ). Comments are skipped and strings read as a browser reads them, except that
// a quote without its end skips only itself, not the rest of the block. more: there were more than MAX_CSS_URLS;
// late: the clock of the page (until) ran out first.
const CSS_SPACE = new Set([' ', '\t', '\n', '\r', '\f']), CSS_NAME = /[\w-]/, URL_FUNCTIONS = new Set(['url', 'src', 'image-set', '-webkit-image-set']);
function stringEnd(text, at) {
  for (let i = at + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === text[at]) return i;
    if (ch === '\\') i++; else if (ch === '\n' || ch === '\r' || ch === '\f') return -1;
  }
  return -1;
}
function nameBefore(text, at) { let i = at; while (i > 0 && at - i < 20 && CSS_NAME.test(text[i - 1])) i--; return text.slice(i, at).toLowerCase(); }
function bareURL(text, at) { let end = at; while (end < text.length && text[end] !== ')' && !CSS_SPACE.has(text[end])) end++; return end; }
function cssFind(css, until = Infinity) {
  const text = String(css), urls = [], open = []; // open: the functions the text is in (their names, the first MAX_NESTING)
  const push = value => { if (value) urls.push(value); };
  const next = /[/"'()@]/g;
  let depth = 0, steps = 0, late = false;
  for (let i = 0; i < text.length && urls.length <= MAX_CSS_URLS; i++) {
    if ((++steps & 1023) === 0 && performance.now() > until) { late = true; break; }
    next.lastIndex = i; if (!next.exec(text)) break;
    i = next.lastIndex - 1;
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 1; }
    else if (ch === '"' || ch === "'") { const end = stringEnd(text, i); if (end < 0) continue; if (depth <= MAX_NESTING && URL_FUNCTIONS.has(open.at(-1))) push(text.slice(i + 1, end)); i = end; }
    else if (ch === '(') {
      const name = nameBefore(text, i);
      if (++depth <= MAX_NESTING) open.push(name);
      if (name !== 'url') continue;
      let j = i + 1; while (j < text.length && CSS_SPACE.has(text[j])) j++;
      if (text[j] !== '"' && text[j] !== "'") { const end = bareURL(text, j); push(text.slice(j, end)); i = end - 1; }
    } else if (ch === ')' && depth > 0) { if (depth-- <= MAX_NESTING) open.pop(); }
    else if (ch === '@' && text.slice(i + 1, i + 7).toLowerCase() === 'import') {
      let j = i + 7; while (j < text.length && CSS_SPACE.has(text[j])) j++;
      const end = text[j] === '"' || text[j] === "'" ? stringEnd(text, j) : -1;
      if (end > 0) { push(text.slice(j + 1, end)); i = end; }
    }
  }
  return { urls: urls.slice(0, MAX_CSS_URLS), more: urls.length > MAX_CSS_URLS, late };
}
const cssURLs = css => cssFind(css).urls;
// The candidates of a srcset: the first MAX_CANDIDATES, and whether there were more.
function candidates(srcset) {
  const text = String(srcset), parts = text.split(',', MAX_CANDIDATES + 1), kept = parts.slice(0, MAX_CANDIDATES);
  const rest = parts.length > MAX_CANDIDATES ? text.slice(kept.reduce((n, part) => n + part.length + 1, 0)) : '';
  return { list: kept.map(part => part.trim().split(/\s+/, 1)[0]).filter(Boolean), more: /[^\s,]/.test(rest) };
}
// The text without comments, as a browser sees them: "<!-->" and "<!--->" are empty comments, "--!>" ends one as "-->"
// does, and a comment that never ends runs to the end of the page.
function stripComments(html) {
  const s = String(html); let at = s.indexOf('<!--');
  if (at < 0) return s;
  const out = []; let from = 0, a = -2, b = -2; // next '-->' and '--!>' (-1: none left), searched again only when passed
  while (at >= 0) {
    out.push(s.slice(from, at));
    let end;
    if (s[at + 4] === '>') end = at + 5;
    else if (s.startsWith('->', at + 4)) end = at + 6;
    else {
      if (a !== -1 && a < at + 4) a = s.indexOf('-->', at + 4);
      if (b !== -1 && b < at + 4) b = s.indexOf('--!>', at + 4);
      end = a < 0 && b < 0 ? s.length : b < 0 || (a >= 0 && a < b) ? a + 3 : b + 4;
    }
    from = end; at = s.indexOf('<!--', from);
  }
  out.push(s.slice(from)); return out.join('');
}
function linkType(a) {
  const rel = (a.rel || '').toLowerCase();
  if (rel.includes('stylesheet')) return 'stylesheet';
  if (rel.includes('icon')) return 'image';
  if (rel.includes('preload') || rel.includes('modulepreload')) return a.as === 'script' || rel.includes('modulepreload') ? 'script' : a.as === 'style' ? 'stylesheet' : a.as === 'image' ? 'image' : a.as === 'document' ? 'frame' : 'other';
  return '';
}
// The text of a title as a browser shows it: entities decoded (RCDATA), read by the same tokenizer.
function decoded(text) {
  const parts = [], keep = token => { parts.push(token.chars); };
  const tokenizer = new Tokenizer({ sourceCodeLocationInfo: false }, { onCharacter: keep, onWhitespaceCharacter: keep, onNullCharacter() {}, onStartTag() {}, onEndTag() {}, onComment() {}, onDoctype() {}, onEof() {} });
  tokenizer.state = TokenizerMode.RCDATA;
  tokenizer.write(text, true);
  return parts.join('');
}

/* Where the page is: in HTML, or inside SVG or MathML. stack holds the open svg and math elements and the HTML islands
   inside them; last is the foreign element that was opened last (an <svg> right inside <annotation-xml> is SVG). */
const nsMode = ns => ns.stack.at(-1)?.ns || 'html';
function popForeign(stack) { while (stack.length && stack.at(-1).ns !== 'html') stack.pop(); }
const breaksOut = (tag, a) => BREAKOUT.has(tag) || (tag === 'font' && (a.color !== undefined || a.face !== undefined || a.size !== undefined));
const htmlAnnotation = (was, tag, a) => was === 'math' && tag === 'annotation-xml' && /^(text\/html|application\/xhtml\+xml)$/i.test(a.encoding || '');
// A start tag, as the tree builder of a browser takes it. Returns whether the tag itself is an HTML element (only then
// can it switch to raw text). An island's own tag is foreign: <svg><title> is the SVG title, not the HTML one.
function nsEnter(ns, tag, a, selfClosing) {
  const { stack } = ns, was = nsMode(ns), open = !selfClosing && stack.length < MAX_NESTING;
  if (!selfClosing && stack.length >= MAX_NESTING) ns.overflow = true; // deeper than tracked: the reader may be wrong from here
  let html = was === 'html';
  if (!html && breaksOut(tag, a)) { popForeign(stack); html = true; }
  else if (!html) { if (open && (ISLAND[was].has(tag) || htmlAnnotation(was, tag, a))) stack.push({ ns: 'html', tag }); }
  else if ((tag === 'mglyph' || tag === 'malignmark') && stack.at(-1)?.ns === 'html' && ISLAND.math.has(stack.at(-1).tag)) { html = false; if (open) stack.push({ ns: 'math', tag }); }
  // SVG inside MathML (or MathML inside SVG) keeps the namespace around it; only <svg> right inside <annotation-xml> is SVG.
  if ((tag === 'svg' || tag === 'math') && open) stack.push({ ns: html ? tag : tag === 'svg' && ns.last === 'annotation-xml' ? 'svg' : was, tag });
  ns.last = html || selfClosing ? '' : tag;
  return html;
}
function nsLeave(ns, tag) {
  const { stack } = ns, top = stack.at(-1);
  ns.last = '';
  if (!top) return;
  if (top.ns !== 'html' && (tag === 'p' || tag === 'br')) popForeign(stack); // </p> and </br> end SVG and MathML too
  else if (top.tag === tag) stack.pop();
  else if (tag === 'svg' || tag === 'math') { const at = stack.findLastIndex(c => c.ns !== 'html' && c.tag === tag); if (at >= 0) stack.length = at; }
}

/* parse5 has no event for two things a browser does, so the tokenizer is watched there (parse5 is pinned at 7.3.0):
   - the attributes of a tag: each new one is checked against all before it (a duplicate name is dropped), so a tag with
     a hundred thousand of them costs seconds. Past MAX_ATTRS only the attributes this reader looks at are kept, each
     name once and the first one, as in a browser: nothing it needs is lost, and the time stays linear;
   - the text of a <![CDATA[ section in SVG or MathML, which comes out as plain characters: a browser that is in HTML at
     that point ends it at the first ">" and reads what follows as markup. */
const USED = new Set([...URL_ATTRS, 'xlink:href', 'data', 'srcdoc', 'style', 'rel', 'as', 'type', 'language', 'name', 'content', 'encoding', 'color', 'face', 'size']);
const WATCHED = ['_leaveAttrName', '_stateMarkupDeclarationOpen', '_stateCdataSection'];
if (WATCHED.some(name => typeof Tokenizer.prototype[name] !== 'function')) throw new Error('html-read.cjs needs the tokenizer of parse5 7.3.0');
function crowded(token, attr, leave) {
  if (token.attrs.length < MAX_ATTRS) return leave();
  token.late ??= new Set();
  if (!USED.has(attr.name) || token.late.has(attr.name)) return;
  token.late.add(attr.name);
  if (!token.attrs.some(a => a.name === attr.name)) token.attrs.push(attr);
}
function watch(tokenizer, reader) {
  const [leave, declaration, cdata] = WATCHED.map(name => tokenizer[name]);
  tokenizer._leaveAttrName = function () { crowded(this.currentToken, this.currentAttr, () => leave.call(this)); };
  tokenizer._stateMarkupDeclarationOpen = function (cp) { declaration.call(this, cp); if (this.state === TokenizerMode.CDATA_SECTION) reader.cdataStart(); };
  tokenizer._stateCdataSection = function (cp) { if (cp >= 0) reader.cdataChar(cp); cdata.call(this, cp); };
  return tokenizer;
}

/* One document: the page (depth 0), the document in an iframe's srcdoc or a noscript block (found for certain), or a
   piece of text read again as markup (maybe: what it finds is possible). All of them write into one run: one result,
   one set of caps, one clock. */
class Reader {
  constructor(run, from, depth, maybe) {
    Object.assign(this, { run, from, base: from, depth, maybe, baseSeen: false, raw: null, anchor: null, nav: 0, footer: false, cdata: null, endsAt: {}, tail: false, ns: { stack: [], last: '' } });
    this.tokenizer = watch(new Tokenizer({ sourceCodeLocationInfo: false }, this), this);
  }
  // In pieces, with the clock read in between. Returns where it stopped.
  read(text) {
    this.text = text;
    let at = 0;
    for (; at < text.length || at === 0; at += CHUNK) {
      const last = at + CHUNK >= text.length;
      if (late(this.run)) break;
      this.tokenizer.write(text.slice(at, at + CHUNK), last);
      if (this.run.halted || last) break;
    }
    this.label();
    return at;
  }
  stop(why) { this.run.out.cut ||= why; }
  halt(why) { this.stop(why); this.run.halted = true; this.tokenizer.pause(); }
  add(value, type) {
    const { run } = this, kind = this.maybe ? 'maybe' : type === 'script' || type === 'frame' ? 'code' : 'rest';
    if (++run.tried[kind] > MAX_ASSETS) return this.stop(`more than ${MAX_ASSETS} ${TRIED[kind]}`);
    const url = toURL(value, this.base);
    if (url) (this.maybe ? run.out.possible : run.out.assets).push({ url: url.href, host: url.hostname.toLowerCase(), type });
  }
  srcset(value) { const found = candidates(value); if (found.more) this.stop(`more than ${MAX_CANDIDATES} candidates in one srcset`); return found.list; }
  css(text) { const found = cssFind(text, this.run.until); if (found.late) late(this.run); if (found.more) this.stop(`more than ${MAX_CSS_URLS} addresses in one style`); for (const u of found.urls) this.add(u, 'other'); }
  // A document or text inside this one, read with it, one level deeper.
  nested(text, maybe) {
    if (this.run.halted || !MARKUP.test(text)) return;
    if (this.depth >= MAX_DEPTH) return this.stop(`documents and text nested more than ${MAX_DEPTH} levels deep`);
    new Reader(this.run, this.base, this.depth + 1, maybe).read(text);
    if (this.run.halted) this.tokenizer.pause();
  }
  inside(text, why) { if (text.length > MAX_SRCDOC) this.stop(why); this.nested(text.slice(0, MAX_SRCDOC), this.maybe); }
  // Whether the raw text that starts after this tag has its end tag further on. Each search starts past the last one
  // found, so all of them together read the text once per element name.
  ends(tag) {
    const from = this.tokenizer.preprocessor.offset + 1, last = this.endsAt[tag];
    if (last && last.from <= from && (last.at < 0 || last.at >= from)) return last.at >= 0;
    const find = new RegExp(`</${tag}[\\t\\n\\f\\r />]`, 'gi');
    find.lastIndex = from;
    const at = find.exec(this.text)?.index ?? -1;
    this.endsAt[tag] = { from, at };
    return at >= 0;
  }

  onStartTag(token) {
    if (++this.run.walked > MAX_WALKED) return this.halt(`more than ${MAX_WALKED} tags`);
    this.cdataEnd();
    const tag = token.tagName, a = {};
    for (const attr of token.attrs) a[attr.name] ??= attr.value;
    this.raw = null;
    const html = nsEnter(this.ns, tag, a, token.selfClosing);
    if (this.ns.overflow) this.stop(`SVG or MathML nested more than ${MAX_NESTING} levels deep`);
    this.tokenizer.inForeignNode = nsMode(this.ns) !== 'html'; // <![CDATA[ is text only there
    // Raw text only in HTML: there the tokenizer is told, as the tree builder of a browser would. In text that is read
    // again as markup, raw text without an end tag further on is not switched to: a browser that takes it for raw text
    // sees nothing after it, one that does not reads on as markup, and reading on is that, without one more level.
    if (html && RAW[tag] !== undefined && (!this.maybe || this.ends(tag))) { this.tokenizer.state = RAW[tag]; this.raw = { tag, a, text: [], size: 0 }; }
    else if (html && tag === 'style' && this.maybe && !this.tail) { this.tail = true; this.css(this.text.slice(this.tokenizer.preprocessor.offset + 1)); }
    // A script or style in SVG is markup with text in it: the text still runs, or applies as CSS.
    else if (!html && (tag === 'script' || tag === 'style') && !token.selfClosing) this.raw = { tag, a, text: [], size: 0, foreign: true };
    if (tag === 'base' && a.href !== undefined && !this.baseSeen) { this.baseSeen = true; const url = toURL(a.href, this.from); if (url) { this.base = url.href; if (this.depth === 0) this.run.out.base = url.href; } }
    this.assets(tag, a, html);
    if (tag === 'iframe' && a.srcdoc) this.inside(a.srcdoc, 'a document in an iframe attribute is longer than 512 KB');
    if (!this.maybe) this.facts(tag, a);
    if (this.run.halted) this.tokenizer.pause();
  }
  assets(tag, a, html) {
    const href = a.href ?? a['xlink:href'];
    if (tag === 'script') { if (html) { if (a.src) this.add(a.src, 'script'); } else for (const value of [href, a.src]) if (value) this.add(value, 'script'); }
    else if (tag === 'link') { const type = linkType(a); if (type && a.href) this.add(a.href, type); }
    else if (tag === 'iframe' || tag === 'frame') { if (a.src) this.add(a.src, 'frame'); }
    // <image> in HTML is <img> to a browser.
    else if (html && (tag === 'img' || tag === 'image' || tag === 'input')) { if (a.src && (tag !== 'input' || String(a.type).trim().toLowerCase() === 'image')) this.add(a.src, 'image'); for (const part of this.srcset(a.srcset || '')) this.add(part, 'image'); }
    else if (tag === 'source') { if (a.src) this.add(a.src, 'other'); for (const part of this.srcset(a.srcset || '')) this.add(part, 'image'); }
    else if (['video', 'audio', 'embed', 'object'].includes(tag) && (a.src || a.data)) this.add(a.src || a.data, 'other');
    else if (!html && (tag === 'image' || tag === 'feimage')) { if (href) this.add(href, 'image'); }
    else if (!html && tag === 'use') { if (href && !href.trim().startsWith('#')) this.add(href, 'other'); }
    if (a.style) this.css(a.style);
  }
  // What the checks need: robots, canonical, generator (of the page itself), and every address in an attribute.
  facts(tag, a) {
    const out = this.run.out;
    if (this.depth === 0 && tag === 'meta') { const name = String(a.name || '').toLowerCase(); if (name === 'robots' || name === 'googlebot') out.robots.push(a.content || ''); else if (name === 'generator') out.generator ||= a.content || ''; }
    else if (this.depth === 0 && tag === 'link' && /(^|\s)canonical(\s|$)/i.test(a.rel || '') && a.href && !out.canonical) out.canonical = a.href;
    if (tag === 'nav' && this.nav === 0) this.nav = 1;
    if (tag === 'footer') this.footer = true;
    if (tag === 'a') this.label();
    const mine = [];
    for (const name of URL_ATTRS) {
      if (!a[name]) continue;
      for (const value of name.endsWith('srcset') ? this.srcset(a[name]) : [a[name]]) {
        if (out.tags.length >= MAX_TAGS) { this.stop(`more than ${MAX_TAGS} addresses in tags`); break; }
        const entry = { tag, attr: name, value: this.baseSeen ? toURL(value, this.base)?.href || value : value, label: '', where: this.footer ? ' in the footer' : this.nav === 1 ? ' in the menu' : '' };
        out.tags.push(entry); mine.push(entry);
      }
    }
    // The text of a link is only collected for a link that has an address.
    if (tag === 'a' && mine.length) this.anchor = { tags: mine, text: [], size: 0 };
  }
  label() { const { anchor } = this; if (!anchor) return; const text = anchor.text.join('').replace(/\s+/g, ' ').trim().slice(0, 40); for (const t of anchor.tags) t.label = text; this.anchor = null; }

  onEndTag(token) {
    this.cdataEnd();
    const tag = token.tagName;
    if (this.raw && this.raw.tag === tag) this.rawEnd(false);
    nsLeave(this.ns, tag);
    this.tokenizer.inForeignNode = nsMode(this.ns) !== 'html';
    if (tag === 'a') this.label();
    if (tag === 'nav' && this.nav === 1) this.nav = 2;
    if (this.run.halted) this.tokenizer.pause();
  }
  // The end of raw text (its end tag, or the end of the page): what it means, and then the same text read as markup.
  rawEnd(atEof) {
    const { tag, a, text: parts, foreign } = this.raw, { run } = this;
    this.raw = null;
    if (late(run)) return;
    const text = parts.join('');
    if (tag === 'script') this.inline(a, text, atEof, foreign);
    else if (tag === 'style') this.css(text);
    else if (tag === 'title' && this.depth === 0 && !run.titleSeen) { run.titleSeen = true; run.out.title = decoded(text.slice(0, 4000)).replace(/\s+/g, ' ').trim().slice(0, 200); }
    if (tag === 'noscript') this.inside(text, 'a noscript block is longer than 512 KB');
    // The text of a script is not read again: it is most of a real page and full of "<" in code and strings; reading it
    // as markup made real pages a third slower and cut some. A script in SVG was markup already.
    else if (!foreign && tag !== 'script') this.nested(text, true);
  }
  // A script without its end tag is not run.
  inline(a, text, atEof, foreign) {
    // An SVG script loads href or xlink:href and ignores language; an HTML script ignores href.
    const external = foreign ? a.href !== undefined || a['xlink:href'] !== undefined : Boolean(a.src);
    if (atEof || external || !text.trim() || !runsAsScript(foreign ? { ...a, language: undefined } : a)) return;
    const list = this.maybe ? this.run.out.possibleScripts : this.run.out.inlineScripts;
    if (list.length >= MAX_INLINE) this.stop(`more than ${MAX_INLINE} inline scripts`); else list.push(text.trim());
  }
  onCharacter(token) {
    const { raw, anchor } = this;
    if (raw && raw.size < MAX_RAW) { raw.text.push(token.chars); raw.size += token.chars.length; }
    else if (raw) this.stop(`a ${raw.tag} is longer than 8 MB`);
    if (anchor && anchor.size < 400) { anchor.text.push(token.chars); anchor.size += token.chars.length; }
  }
  onWhitespaceCharacter(token) { this.onCharacter(token); }
  onComment(token) { this.cdataEnd(); this.nested(token.data, true); }
  onDoctype() { this.cdataEnd(); }
  onNullCharacter() {}
  onEof() {
    this.cdataEnd();
    // A style or title without its end tag still counts in a browser.
    if (this.raw) this.rawEnd(true);
    this.label();
  }
  cdataStart() { this.cdataEnd(); this.cdata = { codes: [], parts: [], size: 0 }; }
  cdataChar(cp) {
    const { cdata } = this;
    if (!cdata || cdata.size >= MAX_RAW) return;
    cdata.codes.push(cp); cdata.size++;
    if (cdata.codes.length >= 4096) { cdata.parts.push(String.fromCodePoint(...cdata.codes)); cdata.codes = []; }
  }
  cdataEnd() {
    const { cdata } = this;
    if (!cdata) return;
    this.cdata = null;
    if (cdata.size >= MAX_RAW) this.stop('a CDATA section is longer than 8 MB');
    this.nested(cdata.parts.join('') + String.fromCodePoint(...cdata.codes), true);
  }
}
const TRIED = { code: 'scripts and frames', rest: 'addresses', maybe: 'addresses inside text' };
const late = run => run.halted || (performance.now() > run.until && (run.halted = run.late = true));
// A page in UTF-16 that was decoded as UTF-8 is mostly NUL characters: it cannot be read here, and that is said.
function mostlyNul(text) {
  const enough = Math.max(64, text.length / 100);
  let nul = 0;
  for (let at = text.indexOf('\0'); at >= 0 && nul < enough; at = text.indexOf('\0', at + 1)) nul++;
  return nul >= enough;
}

/* Reads one page. Returns
     assets [{ url, host, type }], inlineScripts [text]      what the page loads and runs
     possible [{ url, host, type }], possibleScripts [text]  what was found in text that a browser may still read as markup
     title, robots [content], canonical, generator, base     what its head says
     tags [{ tag, attr, value, label, where }]               every address in an attribute (links, forms, images)
     cut                                                     '' or why it was not read to the end */
function read(text, pageURL) {
  const run = { out: { assets: [], inlineScripts: [], possible: [], possibleScripts: [], title: '', robots: [], canonical: '', generator: '', base: pageURL, tags: [], cut: '' },
    until: performance.now() + READ_MS, walked: 0, tried: { code: 0, rest: 0, maybe: 0 }, halted: false, late: false, titleSeen: false };
  if (mostlyNul(text)) run.out.cut = 'most of it is NUL characters: it is in an encoding Dioptra does not read, such as UTF-16 without a byte order mark';
  const at = new Reader(run, pageURL, 0, false).read(text);
  if (run.late) run.out.cut ||= `reading took too long, only the first ${(at / 1048576).toFixed(1)} MB`;
  return run.out;
}
// The same page is read by the comparison, by the checks and for its title: once.
const KEEP = 4, kept = [];
function readPage(html, pageURL) {
  const text = String(html ?? ''), url = String(pageURL || 'about:blank');
  const hit = kept.find(k => k.url === url && k.text.length === text.length && k.text === text);
  if (hit) return hit.page;
  const page = read(text, url);
  kept.unshift({ url, text, page }); kept.length = Math.min(kept.length, KEEP);
  return page;
}
function extractAssets(html, pageURL) { const page = readPage(html, pageURL); return { assets: page.assets, inlineScripts: page.inlineScripts, possible: page.possible, possibleScripts: page.possibleScripts, cut: page.cut }; }

module.exports = { readPage, extractAssets, cssURLs, stripComments, toURL, runsAsScript, MAX_WALKED, MAX_ASSETS, MAX_INLINE, MAX_TAGS, MAX_CANDIDATES, MAX_CSS_URLS, MAX_ATTRS, MAX_DEPTH };
