import Link from '@tiptap/extension-link';
import type {Attributes} from '@tiptap/core';
import type {Node} from '@tiptap/pm/model';
import {Plugin, PluginKey} from '@tiptap/pm/state';
import {Decoration, DecorationSet} from '@tiptap/pm/view';
import {find} from 'linkifyjs';

export function normalizeLink(value: string): string {
  return /^(?:[a-z][\w+.-]*:|[/#])/i.test(value) ? value : 'https://' + value;
}

export function allowedLink(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- 链接地址不能包含控制字符。
  if (!value || value.length > 2048 || /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(value)) return false;
  if (value.startsWith('#')) return true;
  if (value.startsWith('/')) return !value.startsWith('//');
  try {
    // 自动识别裸域名时尚未补协议，真正写入正文的 href 由链接扩展补全。
    const url = new URL(normalizeLink(value));
    if (url.protocol === 'http:' || url.protocol === 'https:') return !!url.hostname && !url.username && !url.password;
    if (url.protocol === 'mailto:') return /^[^@?]+@[^@?]+(?:\?.*)?$/.test(url.pathname + url.search) && !/%0[ad]/i.test(value);
    if (url.protocol === 'tel:') return /^\+?[0-9().-]{3,40}$/.test(url.pathname);
  } catch { /* 无效地址保持普通文字。 */ }
  return false;
}

// 旧备忘录中的纯文本网址仅添加显示装饰，不改正文、版本号或修改时间。
function plainTextLinks(doc: Node): DecorationSet {
  const links: Decoration[] = [];
  doc.descendants((block, position) => {
    if (block.type.spec.code) return false;
    if (!block.isTextblock) return;
    block.descendants((node, offset) => {
      if (!node.isText || node.marks.some(mark => mark.type.name === 'link' || mark.type.name === 'code')) return;
      for (const link of find(node.text ?? '', {defaultProtocol: 'https'})) {
        if (!link.isLink || !allowedLink(link.href)) continue;
        links.push(Decoration.inline(position + 1 + offset + link.start, position + 1 + offset + link.end, {
          nodeName: 'a', href: link.href, target: '_blank', rel: 'noopener noreferrer nofollow',
        }));
      }
    });
    return false;
  });
  return DecorationSet.create(doc, links);
}

export const EditorLink = Link.extend({
  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), new Plugin<DecorationSet>({
      key: new PluginKey('plainTextLinks'),
      state: {
        init: (_, state) => plainTextLinks(state.doc),
        apply: (transaction, previous) => transaction.docChanged ? plainTextLinks(transaction.doc) : previous,
      },
      props: {
        decorations(state) { return this.getState(state); },
        handleDOMEvents: {
          auxclick: (_view, event) => {
            if (event.target instanceof Element && event.target.closest('a[href]')) { event.preventDefault(); return true; }
            return false;
          },
        },
      },
      view(view) {
        const doc = view.dom.ownerDocument, win = doc.defaultView!;
        let alt = false;
        const render = () => view.dom.classList.toggle('editor-alt-links', alt);
        const key = (event: KeyboardEvent) => { alt = event.altKey || (event.type === 'keydown' && event.key === 'Alt'); render(); };
        const mouse = (event: MouseEvent) => { alt = event.altKey; render(); };
        const reset = () => { alt = false; render(); };
        const visibility = () => { if (doc.hidden) reset(); };
        doc.addEventListener('keydown', key, true); doc.addEventListener('keyup', key, true);
        doc.addEventListener('mousemove', mouse, true); doc.addEventListener('mousedown', mouse, true);
        doc.addEventListener('visibilitychange', visibility); win.addEventListener('blur', reset);
        return {update: render, destroy() {
          doc.removeEventListener('keydown', key, true); doc.removeEventListener('keyup', key, true);
          doc.removeEventListener('mousemove', mouse, true); doc.removeEventListener('mousedown', mouse, true);
          doc.removeEventListener('visibilitychange', visibility); win.removeEventListener('blur', reset); reset();
        }};
      },
    })];
  },
  addAttributes() {
    const attributes: Attributes = this.parent?.() ?? {};
    // 正文 API 只接受链接属性；视觉样式由 CSS 控制，不写入 class。
    delete attributes.class;
    return {
      ...attributes,
      href: {...attributes.href, parseHTML: (element: HTMLElement) => {
        const href = element.getAttribute('href');
        return href ? normalizeLink(href) : href;
      }},
      target: {...attributes.target, parseHTML: () => '_blank'},
      rel: {...attributes.rel, parseHTML: () => 'noopener noreferrer nofollow'},
      // 标题保留在正文数据中，不生成浏览器原生 tooltip。
      title: {default: null, parseHTML: (element: HTMLElement) => element.getAttribute('title')?.slice(0, 200) ?? null, renderHTML: () => ({})},
    };
  },
}).configure({
  autolink: true,
  linkOnPaste: true,
  openOnClick: false,
  defaultProtocol: 'https',
  HTMLAttributes: {target: '_blank', rel: 'noopener noreferrer nofollow'},
  isAllowedUri: (href, {defaultValidate}) => allowedLink(href) && defaultValidate(normalizeLink(href)),
});

// 编辑态和只读态都使用同一点击行为，避免离开当前备忘录。
export function openEditorLink(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return false;
  const anchor = event.target.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return false;
  event.preventDefault();
  if (!event.altKey) return false;
  const href = anchor.getAttribute('href');
  if (href && allowedLink(href)) window.open(anchor.href, '_blank', 'noopener,noreferrer');
  return true;
}
