import {useState, type KeyboardEvent, type MouseEvent} from 'react';
import {Dropdown, Menu, Message} from '@arco-design/web-react';
import {EditorContent, useEditorState, type Editor} from '@tiptap/react';
import {Bold, Check, ClipboardPaste, Code, Copy, Eraser, Heading2, ImagePlus, Italic, List, ListChecks, ListOrdered, MessageSquare, Minus, Plus, Quote, Redo2, Scissors, SquareDashed, Strikethrough, Type, Undo2, Table2, Highlighter, Search, ListTree, Maximize2} from 'lucide-react';
import {chooseImages} from './editorImages';
import {editorAction} from './editorSearch';
import {tableActions, tableActionDisabled} from './editorTable';
import {useEditorEditable} from './editorState';

function Label({Icon, text, shortcut, active}: {Icon: typeof Bold; text: string; shortcut?: string; active?: boolean}) {
  return <span className="editor-context-option"><span className="ico-label"><Icon size={16}/><span>{text}</span></span>
    {active ? <Check size={14} aria-label="已启用"/> : shortcut && <span className="editor-context-shortcut">{shortcut}</span>}
  </span>;
}

export function EditorContextMenu({editor, disabled = false, onComment}: {editor: Editor | null; disabled?: boolean; onComment?: () => void}) {
  const [open, setOpen] = useState(false);
  const [clipboardBusy, setClipboardBusy] = useState(false);
  useEditorState({editor, selector: ({transactionNumber}) => open ? transactionNumber : 0});
  const editable = useEditorEditable(editor) && !disabled;
  const selected = !!editor && !editor.state.selection.empty;
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

  async function clipboard(action: 'copy' | 'cut' | 'paste') {
    if (!editor || editor.isDestroyed || clipboardBusy || (action !== 'copy' && !editable)) return;
    const original = editor.state;
    if (action !== 'paste' && original.selection.empty) return;
    setClipboardBusy(true);
    try {
      if (action === 'paste') {
        let html = '', text = '';
        if (navigator.clipboard?.read) {
          const items = await navigator.clipboard.read();
          const image = items.find(item => item.types.some(type => ['image/png', 'image/jpeg', 'image/webp'].includes(type)));
          if (image) {
            const type = image.types.find(type => ['image/png', 'image/jpeg', 'image/webp'].includes(type))!;
            const blob = await image.getType(type);
            if (!editor.isDestroyed && editor.isEditable) editor.commands.uploadImages([new File([blob], '粘贴图片', {type})]);
            return;
          }
          const item = items.find(item => item.types.includes('text/html') || item.types.includes('text/plain'));
          if (item?.types.includes('text/html')) html = await (await item.getType('text/html')).text();
          else if (item?.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
        } else {
          text = await navigator.clipboard.readText();
        }
        if (editor.isDestroyed || !editor.isEditable) return;
        // A clipboard permission prompt can outlive the selection or a remote edit.
        if (!editor.state.doc.eq(original.doc) || !editor.state.selection.eq(original.selection)) {
          Message.warning('内容或选区已变化，请重新粘贴'); return;
        }
        if (!html && !text) { Message.info('剪贴板中没有可粘贴的文字'); return; }
        editor.commands.focus();
        if (html) editor.view.pasteHTML(html);
        else editor.view.pasteText(text);
      } else {
        const {dom, text} = editor.view.serializeForClipboard(original.selection.content());
        if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
          await navigator.clipboard.write([new ClipboardItem({
            'text/plain': new Blob([text], {type: 'text/plain'}),
            'text/html': new Blob([dom.innerHTML], {type: 'text/html'}),
          })]);
        } else {
          await navigator.clipboard.writeText(text);
        }
        if (action === 'cut' && !editor.isDestroyed && editor.isEditable) {
          if (editor.state.doc.eq(original.doc) && editor.state.selection.eq(original.selection)) editor.chain().focus().deleteSelection().run();
          else Message.info('已复制，内容或选区已变化，请重新剪切');
        }
      }
    } catch {
      const key = action === 'copy' ? 'C' : action === 'cut' ? 'X' : 'V';
      Message.info(`无法访问剪贴板，请使用 ${modifier} + ${key} ${action === 'copy' ? '复制' : action === 'cut' ? '剪切' : '粘贴'}`);
    } finally { setClipboardBusy(false); }
  }

  const formats = editor ? [
    {key: 'heading', label: '标题', Icon: Heading2, active: editor.isActive('heading', {level: 2}), run: () => editor.chain().focus().toggleHeading({level: 2}).run()},
    {key: 'bold', label: '粗体', Icon: Bold, shortcut: modifier + ' + B', active: editor.isActive('bold'), run: () => editor.chain().focus().toggleBold().run()},
    {key: 'italic', label: '斜体', Icon: Italic, shortcut: modifier + ' + I', active: editor.isActive('italic'), run: () => editor.chain().focus().toggleItalic().run()},
    {key: 'highlight', label: '高亮', Icon: Highlighter, active: editor.isActive('highlight'), run: () => editor.chain().focus().toggleHighlight().run()},
    {key: 'strike', label: '删除线', Icon: Strikethrough, active: editor.isActive('strike'), run: () => editor.chain().focus().toggleStrike().run()},
    {key: 'code', label: '行内代码', Icon: Code, active: editor.isActive('code'), run: () => editor.chain().focus().toggleCode().run()},
    {key: 'clear', label: '清除格式', Icon: Eraser, run: () => editor.chain().focus().unsetAllMarks().clearNodes().run()},
  ] : [];
  const inserts = editor ? [
    {key: 'table', label: '表格', Icon: Table2, run: () => editor.chain().focus().insertTable({rows: 3, cols: 3, withHeaderRow: true}).run()},
    {key: 'image', label: '图片', Icon: ImagePlus, run: () => chooseImages(editor)},
    {key: 'bullet', label: '无序列表', Icon: List, active: editor.isActive('bulletList'), run: () => editor.chain().focus().toggleBulletList().run()},
    {key: 'ordered', label: '有序列表', Icon: ListOrdered, active: editor.isActive('orderedList'), run: () => editor.chain().focus().toggleOrderedList().run()},
    {key: 'tasks', label: '待办清单', Icon: ListChecks, active: editor.isActive('taskList'), run: () => editor.chain().focus().toggleTaskList().run()},
    {key: 'quote', label: '引用', Icon: Quote, active: editor.isActive('blockquote'), run: () => editor.chain().focus().toggleBlockquote().run()},
    {key: 'code-block', label: '代码块', Icon: Code, active: editor.isActive('codeBlock'), run: () => editor.chain().focus().toggleCodeBlock().run()},
    {key: 'rule', label: '分割线', Icon: Minus, run: () => editor.chain().focus().setHorizontalRule().run()},
  ] : [];
  function run(key: string) {
    if (!editor || editor.isDestroyed) return;
    if (key === 'copy' || key === 'cut' || key === 'paste') { void clipboard(key); return; }
    if (key === 'all') { editor.chain().focus().selectAll().run(); return; }
    if (key === 'comment') { onComment?.(); return; }
    if (key === 'find' || key === 'outline' || key === 'focus') { editorAction(editor, key); return; }
    if (!editable || !editor.isEditable) return;
    const tableAction = tableActions.find(action => 'table:' + action.key === key);
    if (tableAction && !tableActionDisabled(editor, tableAction)) { tableAction.run(editor); return; }
    if (key === 'undo') editor.chain().focus().undo().run();
    else if (key === 'redo') editor.chain().focus().redo().run();
    else [...formats, ...inserts].find(action => action.key === key)?.run();
  }
  function point(event: MouseEvent) {
    if (editor?.isDestroyed || (!event.clientX && !event.clientY)) return null;
    return editor?.view.posAtCoords({left: event.clientX, top: event.clientY})?.pos ?? null;
  }
  function closeOnEscape(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault(); event.stopPropagation(); setOpen(false); editor?.commands.focus();
  }
  const submenuProps = {trigger: ['hover', 'click'] as ('hover' | 'click')[], mouseEnterDelay: 100, mouseLeaveDelay: 200, autoFitPosition: true, popupStyle: {maxHeight: 'min(360px, calc(100dvh - 24px))', overflowY: 'auto' as const}};
  return <Dropdown trigger="contextMenu" disabled={!editor} popupVisible={open} onVisibleChange={setOpen}
    triggerProps={{clickToClose: true, clickOutsideToClose: true, autoFitPosition: true, escToClose: true}} droplist={editor ?
      <Menu className="editor-context-menu" style={{maxHeight: 'min(360px, calc(100dvh - 24px))'}} onKeyDown={closeOnEscape} onClickMenuItem={key => run(String(key))}>
        <Menu.Item key="undo" disabled={!editable || !editor.can().undo()}><Label Icon={Undo2} text="撤销" shortcut={modifier + ' + Z'}/></Menu.Item>
        <Menu.Item key="redo" disabled={!editable || !editor.can().redo()}><Label Icon={Redo2} text="重做"/></Menu.Item>
        <Menu.Item key="cut" disabled={!editable || !selected || clipboardBusy}><Label Icon={Scissors} text="剪切" shortcut={modifier + ' + X'}/></Menu.Item>
        <Menu.Item key="copy" disabled={!selected || clipboardBusy}><Label Icon={Copy} text="复制" shortcut={modifier + ' + C'}/></Menu.Item>
        <Menu.Item key="paste" disabled={!editable || clipboardBusy}><Label Icon={ClipboardPaste} text="粘贴" shortcut={modifier + ' + V'}/></Menu.Item>
        <Menu.Item key="all"><Label Icon={SquareDashed} text="全选" shortcut={modifier + ' + A'}/></Menu.Item>
        {onComment && <Menu.Item key="comment"><Label Icon={MessageSquare} text="评论"/></Menu.Item>}
        <Menu.Item key="find"><Label Icon={Search} text="查找替换" shortcut={modifier + ' + F'}/></Menu.Item>
        <Menu.Item key="outline"><Label Icon={ListTree} text="文档大纲"/></Menu.Item>
        <Menu.Item key="focus"><Label Icon={Maximize2} text="专注模式"/></Menu.Item>
        {editable && editor.isActive('table') && <Menu.SubMenu key="table-options" title={<Label Icon={Table2} text="表格操作"/>} popup triggerProps={submenuProps}>
          {tableActions.map(action => <Menu.Item key={'table:' + action.key} disabled={tableActionDisabled(editor, action)}>{action.label}</Menu.Item>)}
        </Menu.SubMenu>}
        {editable ? <Menu.SubMenu key="format" title={<Label Icon={Type} text="文字格式"/>} popup triggerProps={submenuProps}>
          {formats.map(action => <Menu.Item key={action.key} disabled={!editable}><Label Icon={action.Icon} text={action.label} shortcut={'shortcut' in action ? action.shortcut : undefined} active={'active' in action && action.active}/></Menu.Item>)}
        </Menu.SubMenu> : <Menu.Item key="format" disabled><Label Icon={Type} text="文字格式"/></Menu.Item>}
        {editable ? <Menu.SubMenu key="insert" title={<Label Icon={Plus} text="插入"/>} popup triggerProps={submenuProps}>
          {inserts.map(action => <Menu.Item key={action.key} disabled={!editable}><Label Icon={action.Icon} text={action.label} active={'active' in action && action.active}/></Menu.Item>)}
        </Menu.SubMenu> : <Menu.Item key="insert" disabled><Label Icon={Plus} text="插入"/></Menu.Item>}
      </Menu> : <Menu/>
    }>
    <div onKeyDown={closeOnEscape} onMouseDown={event => {
      if (event.button !== 2 || !editor || editor.isDestroyed) return;
      const position = point(event), selection = editor.state.selection;
      if (position !== null && !selection.empty && position >= selection.from && position <= selection.to) event.preventDefault();
    }} onContextMenu={event => {
      if (!editor || editor.isDestroyed) return;
      const position = point(event), selection = editor.state.selection;
      if (position !== null && (selection.empty || position < selection.from || position > selection.to)) editor.commands.setTextSelection(position);
    }}><EditorContent editor={editor}/></div>
  </Dropdown>;
}
