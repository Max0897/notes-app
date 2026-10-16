import {Marked} from 'marked';

const documentMarkdown = new Marked({gfm: true}, {extensions: [{
  name: 'highlight', level: 'inline', start: source => source.indexOf('=='),
  tokenizer(source) {
    const match = /^==(?=\S)([^\n]*?\S)==/.exec(source);
    if (match) return {type: 'highlight', raw: match[0], tokens: this.lexer.inlineTokens(match[1])};
  },
}]});

type Node = {type: string; text?: string; attrs?: Record<string, any>; content?: Node[]; marks?: {type: string; attrs?: Record<string, any>}[]};
const paragraph = (content: Node[] = []): Node => ({type: 'paragraph', ...(content.length ? {content} : {})});
function paragraphBlocks(tokens: any[]): Node[] {
  const result: Node[] = []; let pending: any[] = [];
  const flush = () => { if (pending.length) { result.push(paragraph(inline(pending))); pending = []; } };
  for (const token of tokens) {
    const id = token.type === 'image' && /^\/api\/images\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(token.href ?? '')?.[1];
    if (id) { flush(); result.push({type: 'image', attrs: {imageId: id, src: token.href, alt: (token.text ?? '').slice(0, 200), title: null}}); }
    else pending.push(token);
  }
  flush(); return result.length ? result : [paragraph()];
}
function inline(tokens: any[] = [], marks: NonNullable<Node['marks']> = []): Node[] {
  return tokens.flatMap(token => {
    const mark = {strong: 'bold', em: 'italic', del: 'strike', codespan: 'code', highlight: 'highlight'}[token.type as string];
    if (mark) return token.tokens ? inline(token.tokens, [...marks, {type: mark}]) : [{type: 'text', text: token.text, marks: [...marks, {type: mark}]}];
    if (token.type === 'link') {
      let safe = false; try { const url = new URL(token.href, 'https://notes.invalid'); safe = ['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol) && !url.username && !url.password; } catch { /* Keep unsafe destinations as text. */ }
      return inline(token.tokens, safe ? [...marks, {type: 'link', attrs: {href: token.href, target: '_blank', rel: 'noopener noreferrer'}}] : marks);
    }
    if (token.type === 'br' || token.type === 'html' && /^<br\s*\/?\s*>$/i.test(token.raw)) return [{type: 'hardBreak'}];
    if (token.tokens) return inline(token.tokens, marks);
    const text = token.type === 'image' ? token.text : token.type === 'html' ? token.raw : token.text ?? token.raw ?? '';
    return text ? [{type: 'text', text, ...(marks.length ? {marks} : {})}] : [];
  });
}
function blocks(tokens: any[]): Node[] {
  return tokens.flatMap(token => {
    if (token.type === 'space' || token.type === 'def' || token.type === 'checkbox') return [];
    if (token.type === 'heading') return [{type: 'heading', attrs: {level: token.depth}, content: inline(token.tokens)}];
    if (token.type === 'paragraph' || token.type === 'text') return paragraphBlocks(token.tokens ?? [{type: 'text', text: token.text}]);
    if (token.type === 'blockquote') return [{type: 'blockquote', content: blocks(token.tokens)}];
    if (token.type === 'hr') return [{type: 'horizontalRule'}];
    if (token.type === 'code') return [{type: 'codeBlock', ...(token.lang && /^[\w+-]{1,40}$/.test(token.lang) ? {attrs: {language: token.lang}} : {}), ...(token.text ? {content: [{type: 'text', text: token.text}]} : {})}];
    if (token.type === 'table') {
      const row = (cells: any[], header: boolean): Node => ({type: 'tableRow', content: cells.map(cell => ({type: header ? 'tableHeader' : 'tableCell', attrs: {colspan: 1, rowspan: 1, colwidth: null}, content: [paragraph(inline(cell.tokens))]}))});
      return [{type: 'table', content: [row(token.header, true), ...token.rows.map((cells: any[]) => row(cells, false))]}];
    }
    if (token.type === 'list') {
      // Split mixed checklists and normal lists into valid editor containers.
      const groups: Node[] = [];
      for (const item of token.items) {
        const type = item.task ? 'taskList' : token.ordered ? 'orderedList' : 'bulletList';
        let group = groups.at(-1);
        if (!group || group.type !== type) { group = {type, ...(token.ordered && !item.task ? {attrs: {start: token.start}} : {}), content: []}; groups.push(group); }
        const content = blocks(item.tokens); if (!content.length || content[0].type !== 'paragraph') content.unshift(paragraph());
        group.content!.push({type: item.task ? 'taskItem' : 'listItem', ...(item.task ? {attrs: {checked: !!item.checked}} : {}), content});
      }
      return groups;
    }
    return [paragraph([{type: 'text', text: token.raw || token.text || ''}].filter(n => n.text))];
  });
}
export function parseDocument(text: string, markdown: boolean) {
  const content = markdown ? blocks(documentMarkdown.lexer(text)) : text.split(/\r?\n\s*\r?\n/).map(line => paragraph(line ? [{type: 'text', text: line}] : []));
  return {type: 'doc', content: content.length ? content : [paragraph()]};
}
export function plainText(node: Node): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'table') return (node.content ?? []).map(plainText).join('\n');
  if (node.type === 'tableRow') return (node.content ?? []).map(plainText).join('\t');
  return (node.content ?? []).map(plainText).join(['doc', 'blockquote', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem', 'tableCell', 'tableHeader'].includes(node.type) ? '\n\n' : '');
}
const escape = (text: string) => text.replace(/([\\`*_[\]<>~=])/g, '\\$1');
export function markdown(node: Node): string {
  if (node.type === 'text') {
    let value = escape(node.text ?? '');
    if (node.marks?.some(mark => mark.type === 'code')) {
      const raw = node.text ?? '', fence = '`'.repeat(Math.max(0, ...(raw.match(/`+/g) ?? []).map(run => run.length)) + 1);
      value = fence + ' ' + raw + ' ' + fence;
    }
    for (const mark of node.marks ?? []) {
      if (mark.type === 'bold') value = '**' + value + '**';
      else if (mark.type === 'italic') value = '*' + value + '*';
      else if (mark.type === 'strike') value = '~~' + value + '~~';
      else if (mark.type === 'highlight') value = '==' + value + '==';
      else if (mark.type === 'link') value = '[' + value + '](' + String(mark.attrs?.href ?? '').replace(/\(/g, '%28').replace(/\)/g, '%29') + ')';
    }
    return value;
  }
  if (node.type === 'hardBreak') return '  \n';
  if (node.type === 'horizontalRule') return '---';
  if (node.type === 'image') return '![' + escape(node.attrs?.alt ?? '') + '](' + node.attrs?.src + ')';
  if (node.type === 'table') {
    const grid: string[][] = [];
    (node.content ?? []).forEach((row, rowIndex) => {
      const current = grid[rowIndex] ??= []; let column = 0;
      for (const cell of row.content ?? []) {
        while (current[column] !== undefined) column++;
        const colspan = Math.min(100, cell.attrs?.colspan ?? 1), rowspan = Math.min(100, cell.attrs?.rowspan ?? 1);
        for (let r = 0; r < rowspan; r++) for (let c = 0; c < colspan; c++) (grid[rowIndex + r] ??= [])[column + c] = '';
        current[column] = markdown(cell).trim().replace(/\|/g, '\\|').replace(/ {2}\n/g, '<br>').replace(/\n+/g, '<br>');
        column += colspan;
      }
    });
    const width = Math.max(0, ...grid.map(row => row.length));
    if (!width) return '';
    const line = (row: string[]) => '| ' + Array.from({length: width}, (_, column) => row[column] ?? '').join(' | ') + ' |';
    return [line(grid[0]), line(Array(width).fill('---')), ...grid.slice(1).map(line)].join('\n');
  }
  if (node.type === 'codeBlock') { const text = plainText(node); const fence = '`'.repeat(Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length)) + 1); return fence + (node.attrs?.language ?? '') + '\n' + text + '\n' + fence; }
  if (['bulletList', 'orderedList', 'taskList'].includes(node.type)) return (node.content ?? []).map((item, index) => {
    const prefix = node.type === 'orderedList' ? `${(node.attrs?.start ?? 1) + index}. ` : node.type === 'taskList' ? `- [${item.attrs?.checked ? 'x' : ' '}] ` : '- ';
    return prefix + markdown(item).replace(/\n/g, '\n' + ' '.repeat(prefix.length));
  }).join('\n');
  const body = (node.content ?? []).map(markdown).join(['doc', 'blockquote', 'listItem', 'taskItem', 'tableCell', 'tableHeader'].includes(node.type) ? '\n\n' : '');
  if (node.type === 'heading') return '#'.repeat(node.attrs?.level ?? 2) + ' ' + body;
  if (node.type === 'blockquote') return body.split('\n').map(line => '> ' + line).join('\n');
  return body;
}
