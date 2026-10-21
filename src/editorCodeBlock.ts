import CodeBlock from '@tiptap/extension-code-block';

const copyIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const doneIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  const area = document.createElement('textarea');
  area.value = text; area.style.cssText = 'position:fixed;opacity:0'; document.body.append(area); area.select();
  const ok = document.execCommand('copy'); area.remove();
  if (!ok) throw new Error('copy failed');
}

// Code block with a copy button in the top-right corner; shared by personal, team and history views.
export const EditorCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ({node}) => {
      let current = node, timer: number | undefined;
      const dom = document.createElement('div'), button = document.createElement('button'), pre = document.createElement('pre'), code = document.createElement('code');
      dom.className = 'code-block';
      button.type = 'button'; button.className = 'code-copy-button'; button.contentEditable = 'false'; button.innerHTML = copyIcon;
      const label = (text: string) => { button.setAttribute('aria-label', text); button.title = text; };
      label('复制代码');
      const language = (n: typeof node) => n.attrs.language ? `${this.options.languageClassPrefix}${n.attrs.language}` : '';
      code.className = language(node);
      pre.append(code); dom.append(button, pre);
      // Keep focus and selection in the editor when pressing the button.
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', event => {
        event.preventDefault();
        void copyText(current.textContent).then(() => { button.innerHTML = doneIcon; label('已复制'); }).catch(() => label('复制失败，请手动选择复制'))
          .finally(() => { window.clearTimeout(timer); timer = window.setTimeout(() => { button.innerHTML = copyIcon; label('复制代码'); }, 1500); });
      });
      return {
        dom, contentDOM: code,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated; code.className = language(updated); return true;
        },
        stopEvent: event => event.target === button,
        ignoreMutation: mutation => mutation.target === button || button.contains(mutation.target),
        destroy() { window.clearTimeout(timer); },
      };
    };
  },
});
