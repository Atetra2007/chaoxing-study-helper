// Build and stale-build verification must use exactly the same transformation.
function validVersion(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/.test(value)) return false;
  const parts = value.split('.').map(Number);
  return parts.some(value => value > 0) && parts.every(value => value <= 65535);
}
function versioned(value, version) {
  const hashAt = value.indexOf('#'), fragment = hashAt < 0 ? '' : value.slice(hashAt);
  const address = hashAt < 0 ? value : value.slice(0, hashAt);
  const queryAt = address.indexOf('?'), pathname = queryAt < 0 ? address : address.slice(0, queryAt);
  const query = queryAt < 0 ? [] : address.slice(queryAt + 1).split('&').filter(part => part && !/^v(?:=|$)/.test(part));
  return `${pathname}?${[...query, `v=${version}`].join('&')}${fragment}`;
}
function moduleReferences(source, version) {
  // Read declaration tokens rather than matching "import" inside comments,
  // strings or template text. Dynamic import/import.meta stay untouched.
  const tokens = [...source.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g)]
    .filter(token => !token[0].startsWith('//') && !token[0].startsWith('/*'));
  const edits = [];let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index], word = token[0], previous = tokens[index - 1];
    const boundary = !previous || [';', '}'].includes(previous[0]) || /[\r\n]/.test(source.slice(previous.index + previous[0].length, token.index));
    if (depth === 0 && boundary && ['import', 'export'].includes(word)) {
      const next = tokens[index + 1]?.[0];let specifier;
      if (word === 'import' && /^['"]/.test(next || '')) specifier = tokens[index + 1];
      else if ((word === 'import' && next && !['(', '.'].includes(next)) || (word === 'export' && ['{', '*'].includes(next))) {
        for (let cursor = index + 1; cursor < tokens.length && tokens[cursor][0] !== ';'; cursor++) {
          if (tokens[cursor][0] === 'from' && /^['"]/.test(tokens[cursor + 1]?.[0] || '')) { specifier = tokens[cursor + 1];break; }
        }
      }
      if (specifier) {
        const value = specifier[0].slice(1, -1);
        if (/^\.{1,2}\//.test(value) && !value.includes('\\')) edits.push({ start: specifier.index + 1, end: specifier.index + specifier[0].length - 1, value: versioned(value, version) });
      }
    }
    if (word === '{') depth++;else if (word === '}') depth--;
  }
  for (const edit of edits.reverse()) source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  return source;
}
function htmlReferences(source, version) {
  return source.replace(/<!--[\s\S]*?-->|<script\b[^>]*(?:>[\s\S]*?<\/script\s*>|\/>)|<link\b[^>]*>/gi, tag => {
    if (tag.startsWith('<!--')) return tag;
    const attribute = /^<script\b/i.test(tag) ? 'src' : 'href';
    const end = tag.indexOf('>');
    return tag.slice(0, end).replace(new RegExp(`(\\s${attribute}\\s*=\\s*)(["'])(.*?)\\2`, 'i'), (match, prefix, quote, raw) => {
      const value = raw.replace(/&amp;/gi, '&');
      if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|#|\?)/i.test(value)) return match;
      return prefix + quote + versioned(value, version).replace(/&/g, '&amp;') + quote;
    }) + tag.slice(end);
  });
}
export function buildSource(name, source, version) {
  let result = source.toString();
  if (name === 'stream-hash.js') result = result.replace("'@noble/hashes/sha2.js'", "'./vendor/noble-hashes/sha2.js'");
  if (version !== undefined) {
    if (!validVersion(version)) throw new Error('构建版本无效。');
    if (/\.js$/i.test(name)) result = moduleReferences(result, version);
    if (/\.html$/i.test(name)) result = htmlReferences(result, version);
  }
  return result === source.toString() ? source : Buffer.from(result);
}
