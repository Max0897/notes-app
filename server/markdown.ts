import {marked} from 'marked';

type Node = {type: string; text?: string; attrs?: Record<string, any>; content?: Node[]; marks?: {type: string; attrs?: Record<string, any>}[]};
const paragraph = (content: Node[] = []): Node => ({type: 'paragraph', ...(content.length ? {content} : {})});
function inline(tokens: any[] = [], marks: NonNullable<Node['marks']> = []): Node[] {
  return tokens.flatMap(token => {
    const mark = {strong: 'bold', em: 'italic', del: 'strike', codespan: 'code'}[token.type as string];
    if (mark) return token.tokens ? inline(token.tokens, [...marks, {type: mark}]) : [{type: 'text', text: token.text, marks: [...marks, {type: mark}]}];
    if (token.type === 'link') {
      let safe = false; try { const url = new URL(token.href, 'https://notes.invalid'); safe = ['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol) && !url.username && !url.password; } catch { /* Keep unsafe destinations as text. */ }
      return inline(token.tokens, safe ? [...marks, {type: 'link', attrs: {href: token.href, target: '_blank', rel: 'noopener noreferrer'}}] : marks);
    }
    if (token.type === 'br') return [{type: 'hardBreak'}];
    if (token.tokens) return inline(token.tokens, marks);
    const text = token.type === 'image' ? token.text : token.type === 'html' ? token.raw : token.text ?? token.raw ?? '';
    return text ? [{type: 'text', text, ...(marks.length ? {marks} : {})}] : [];
  });
}
function blocks(tokens: any[]): Node[] {
  return tokens.flatMap(token => {
    if (token.type === 'space' || token.type === 'def' || token.type === 'checkbox') return [];
    if (token.type === 'heading') return [{type: 'heading', attrs: {level: token.depth}, content: inline(token.tokens)}];
    if (token.type === 'paragraph' || token.type === 'text') return [paragraph(inline(token.tokens ?? [{type: 'text', text: token.text}]))];
    if (token.type === 'blockquote') return [{type: 'blockquote', content: blocks(token.tokens)}];
    if (token.type === 'hr') return [{type: 'horizontalRule'}];
    if (token.type === 'code') return [{type: 'codeBlock', ...(token.lang && /^[\w+-]{1,40}$/.test(token.lang) ? {attrs: {language: token.lang}} : {}), ...(token.text ? {content: [{type: 'text', text: token.text}]} : {})}];
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
  const content = markdown ? blocks(marked.lexer(text, {gfm: true})) : text.split(/\r?\n\s*\r?\n/).map(line => paragraph(line ? [{type: 'text', text: line}] : []));
  return {type: 'doc', content: content.length ? content : [paragraph()]};
}
export function plainText(node: Node): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  return (node.content ?? []).map(plainText).join(['doc', 'blockquote', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem'].includes(node.type) ? '\n\n' : '');
}
const escape = (text: string) => text.replace(/([\\`*_[\]<>~])/g, '\\$1');
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
      else if (mark.type === 'link') value = '[' + value + '](' + String(mark.attrs?.href ?? '').replace(/\(/g, '%28').replace(/\)/g, '%29') + ')';
    }
    return value;
  }
  if (node.type === 'hardBreak') return '  \n';
  if (node.type === 'horizontalRule') return '---';
  if (node.type === 'codeBlock') { const text = plainText(node); const fence = '`'.repeat(Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length)) + 1); return fence + (node.attrs?.language ?? '') + '\n' + text + '\n' + fence; }
  if (['bulletList', 'orderedList', 'taskList'].includes(node.type)) return (node.content ?? []).map((item, index) => {
    const prefix = node.type === 'orderedList' ? `${(node.attrs?.start ?? 1) + index}. ` : node.type === 'taskList' ? `- [${item.attrs?.checked ? 'x' : ' '}] ` : '- ';
    return prefix + markdown(item).replace(/\n/g, '\n' + ' '.repeat(prefix.length));
  }).join('\n');
  const body = (node.content ?? []).map(markdown).join(['doc', 'blockquote', 'listItem', 'taskItem'].includes(node.type) ? '\n\n' : '');
  if (node.type === 'heading') return '#'.repeat(node.attrs?.level ?? 2) + ' ' + body;
  if (node.type === 'blockquote') return body.split('\n').map(line => '> ' + line).join('\n');
  return body;
}
