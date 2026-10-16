import {useEffect, useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {useEditorState, type Editor} from '@tiptap/react';
import {Button, Checkbox, Empty, Input, Message, Popover, Tooltip} from '@arco-design/web-react';
import {ArrowDown, ArrowUp, Bold, Highlighter, Italic, Link2, ListTree, MessageSquare, Minimize2, Search, Unlink, X} from 'lucide-react';
import {TextSelection} from '@tiptap/pm/state';
import {allowedLink, normalizeLink} from './editorLinks';
import {replaceMatch, searchState, selectMatch, setSearch, type EditorAction} from './editorSearch';
import {filteredCommands, runInsert, slashKey} from './editorSlash';
import {documentOutline} from './editorOutline';
import {useEditorEditable} from './editorState';

function LinkTool({editor}: {editor: Editor}) {
  const [open, setOpen] = useState(false), [url, setUrl] = useState('');
  function save() {
    const href = normalizeLink(url.trim());
    if (!url.trim() || !allowedLink(href)) { Message.warning('请输入有效的链接地址'); return; }
    if (!editor.isEditable || editor.isDestroyed) return;
    editor.chain().focus().extendMarkRange('link').setLink({href, target: '_blank', rel: 'noopener noreferrer nofollow'}).run();
    setOpen(false);
  }
  return <Popover trigger="click" position="bottom" popupVisible={open} onVisibleChange={visible => {
    setOpen(visible); if (visible) setUrl(editor.getAttributes('link').href ?? '');
  }} content={<form className="editor-link-form" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); editor.commands.focus(); } }} onSubmit={event => {event.preventDefault(); save();}}>
    <Input aria-label="链接地址" placeholder="https://example.com" value={url} maxLength={2048} onChange={setUrl} autoFocus/>
    <Button size="small" type="primary" htmlType="submit">确定</Button>
    {editor.isActive('link') && <Button size="small" type="text" aria-label="移除链接" icon={<Unlink size={16}/>} onClick={() => { if (editor.isEditable) editor.chain().focus().extendMarkRange('link').unsetLink().run(); setOpen(false); }}/>}
  </form>}>
    <Button type={editor.isActive('link') ? 'secondary' : 'text'} size="small" aria-label="设置链接" icon={<Link2 size={16}/>} onMouseDown={event => event.preventDefault()}/>
  </Popover>;
}

export function EditorFeatures({editor, onComment}: {editor: Editor; onComment?: () => void}) {
  useEditorState({editor, selector: ({transactionNumber}) => transactionNumber});
  const editable = useEditorEditable(editor);
  const [pane, setPane] = useState<HTMLElement | null>(null);
  const [findOpen, setFindOpen] = useState(false), [outlineOpen, setOutlineOpen] = useState(false), [focused, setFocused] = useState(false);
  const [term, setTerm] = useState(''), [replacement, setReplacement] = useState(''), [sensitive, setSensitive] = useState(false);
  const [showReplace, setShowReplace] = useState(false), [findRequest, setFindRequest] = useState(0);
  const [composing, setComposing] = useState(false), [slashPosition, setSlashPosition] = useState({left: 0, top: 0});
  const [bubblePosition, setBubblePosition] = useState({left: 0, top: 0}), [dismissedSelection, setDismissedSelection] = useState<object | null>(null);
  const findInput = useRef<HTMLInputElement>(null), findPanel = useRef<HTMLDivElement>(null), slashPanel = useRef<HTMLDivElement>(null);
  const bubblePanel = useRef<HTMLDivElement>(null);
  const slashId = useId();
  const search = searchState(editor), slash = slashKey.getState(editor.state);
  const options = slash ? filteredCommands(slash.query) : [];
  const doc = editor.state.doc;
  const selection = editor.state.selection;
  const showBubble = editable && !findOpen && !slash && !composing && selection instanceof TextSelection && !selection.empty && selection !== dismissedSelection && !!doc.textBetween(selection.from, selection.to).trim();
  const headings = useMemo(() => outlineOpen ? documentOutline(doc) : [], [doc, outlineOpen]);
  useEffect(() => {
    const element = editor.view.dom;
    // The editor DOM is attached by EditorContent after the initial render.
    // oxlint-disable-next-line react/set-state-in-effect
    setPane(element.closest<HTMLElement>('.editor-pane'));
    function action(event: Event) {
      switch ((event as CustomEvent<EditorAction>).detail) {
        case 'find': {
          const {from, to} = editor.state.selection;
          const selection = editor.state.doc.textBetween(from, to, ' ').slice(0, 500);
          if (selection) setTerm(selection);
          setOutlineOpen(false); setFindOpen(true); setFindRequest(value => value + 1); break;
        }
        case 'outline': setFindOpen(false); setOutlineOpen(value => !value); break;
        case 'focus': setFocused(value => !value); break;
      }
    }
    const start = () => setComposing(true), end = () => setComposing(false);
    element.addEventListener('editor:action', action);
    element.addEventListener('compositionstart', start); element.addEventListener('compositionend', end);
    return () => { element.removeEventListener('editor:action', action); element.removeEventListener('compositionstart', start); element.removeEventListener('compositionend', end); };
  }, [editor]);
  useEffect(() => {
    if (editor.isDestroyed) return;
    setSearch(editor, findOpen ? term : '', sensitive);
    if (findOpen && term) selectMatch(editor, 0);
  }, [editor, findOpen, term, sensitive]);
  useEffect(() => () => { if (!editor.isDestroyed) setSearch(editor, '', false); }, [editor]);
  useEffect(() => {
    if (findOpen) { findInput.current?.focus(); findInput.current?.select(); }
  }, [findOpen, findRequest]);
  useEffect(() => {
    const shell = pane?.closest('.app-shell');
    shell?.classList.toggle('editor-focus-mode', focused);
    pane?.classList.toggle('has-editor-outline', outlineOpen);
    return () => { shell?.classList.remove('editor-focus-mode'); pane?.classList.remove('has-editor-outline'); };
  }, [pane, focused, outlineOpen]);
  useLayoutEffect(() => {
    const bar = pane?.querySelector<HTMLElement>('.format-bar');
    if (!pane || !bar) return;
    const resize = () => pane.style.setProperty('--editor-tools-bottom', bar.offsetTop + bar.offsetHeight + 8 + 'px');
    resize(); const observer = new ResizeObserver(resize); observer.observe(bar);
    return () => { observer.disconnect(); pane.style.removeProperty('--editor-tools-bottom'); };
  }, [pane]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f' && pane?.contains(event.target as Node)) {
        event.preventDefault(); setOutlineOpen(false); setFindOpen(true); setFindRequest(value => value + 1);
      } else if (event.key === 'Escape') {
        if (document.querySelector('.editor-link-form')) return;
        if (slash) { event.preventDefault(); editor.view.dispatch(editor.state.tr.setMeta(slashKey, {close: true})); }
        else if (findOpen) { event.preventDefault(); setFindOpen(false); editor.commands.focus(); }
        else if (focused) { event.preventDefault(); setFocused(false); }
        else if (outlineOpen) { event.preventDefault(); setOutlineOpen(false); }
        else if (showBubble) { event.preventDefault(); setDismissedSelection(editor.state.selection); }
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [pane, focused, editor, slash, findOpen, outlineOpen, showBubble]);
  useLayoutEffect(() => {
    if (!slash || !editor.isEditable || composing) return;
    const place = () => {
      if (editor.isDestroyed) return;
      const rect = editor.view.coordsAtPos(Math.min(slash.to, editor.state.doc.content.size));
      const height = Math.min(slashPanel.current?.offsetHeight || 300, window.innerHeight - 24);
      setSlashPosition({left: Math.max(12, Math.min(rect.left, window.innerWidth - 272)), top: Math.max(12, rect.bottom + height + 10 < window.innerHeight ? rect.bottom + 6 : rect.top - height - 6)});
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    slashPanel.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block: 'nearest'});
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [editor, slash, composing]);
  useEffect(() => {
    if (!slash) return;
    const outside = (event: PointerEvent) => {
      if (!slashPanel.current?.contains(event.target as Node) && !editor.view.dom.contains(event.target as Node)) editor.view.dispatch(editor.state.tr.setMeta(slashKey, {close: true}));
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [editor, slash]);
  useLayoutEffect(() => {
    if (!showBubble) return;
    const place = () => {
      if (editor.isDestroyed) return;
      const size = editor.state.doc.content.size;
      const start = editor.view.coordsAtPos(Math.min(selection.from, size)), end = editor.view.coordsAtPos(Math.min(selection.to, size));
      const width = bubblePanel.current?.offsetWidth || 180, height = bubblePanel.current?.offsetHeight || 40;
      const center = end.top - start.top > 40 ? start.left + width / 2 : (start.left + end.right) / 2;
      setBubblePosition({left: Math.max(12, Math.min(center - width / 2, window.innerWidth - width - 12)), top: Math.max(12, start.top >= height + 12 ? start.top - height - 6 : end.bottom + 6)});
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [editor, selection, showBubble]);
  useEffect(() => {
    if (!showBubble) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (event.button === 2 || !bubblePanel.current?.contains(target) && !target.closest?.('.arco-popover') && !editor.view.dom.contains(target)) setDismissedSelection(editor.state.selection);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [editor, showBubble]);
  function closeFind() { setFindOpen(false); editor.commands.focus(); }
  function replace(all = false) {
    if (!editor.isEditable) return;
    const matches = all ? search.matches : search.matches.slice(search.index, search.index + 1);
    if (matches.length && (editor.state.doc.textContent.length + matches.reduce((total, match) => total + replacement.length - (match.to - match.from), 0)) > 200_000) {
      Message.warning('替换后的正文过长，请缩小替换范围'); return;
    }
    const count = replaceMatch(editor, replacement, all);
    if (count) selectMatch(editor, searchState(editor).index);
    if (all && count) Message.success('已替换 ' + count + ' 处');
  }
  return <>
    {showBubble && createPortal(<div ref={bubblePanel} className="editor-bubble" role="toolbar" aria-label="文字格式" style={bubblePosition}>
      {[
        {label: '粗体', Icon: Bold, active: editor.isActive('bold'), run: () => editor.chain().focus().toggleBold().run()},
        {label: '斜体', Icon: Italic, active: editor.isActive('italic'), run: () => editor.chain().focus().toggleItalic().run()},
        {label: '高亮', Icon: Highlighter, active: editor.isActive('highlight'), run: () => editor.chain().focus().toggleHighlight().run()},
      ].map(({label, Icon, active, run}) => <Tooltip key={label} content={label}><Button size="small" type={active ? 'secondary' : 'text'} aria-label={label} icon={<Icon size={16}/>} onMouseDown={event => event.preventDefault()} onClick={() => { if (editor.isEditable) run(); }}/></Tooltip>)}
      <LinkTool editor={editor}/>
      {onComment && <Tooltip content="评论"><Button size="small" type="text" aria-label="评论选中文字" icon={<MessageSquare size={16}/>} onMouseDown={event => event.preventDefault()} onClick={onComment}/></Tooltip>}
    </div>, document.body)}
    {pane && createPortal(<>
      {findOpen && <div className="editor-find-panel" role="search" aria-label="文内查找替换" ref={findPanel} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFind(); }
        else if (event.key === 'Enter' && event.target === findInput.current) { event.preventDefault(); selectMatch(editor, search.index + (event.shiftKey ? -1 : 1)); }
      }}>
        <div className="editor-find-row"><Search size={16}/><input ref={findInput} aria-label="查找内容" placeholder="查找内容" maxLength={500} value={term} onChange={event => setTerm(event.target.value)}/>
          <span className="editor-find-count" aria-live="polite">{search.matches.length ? search.index + 1 + '/' + search.matches.length : term ? '无结果' : '0/0'}</span>
          <Button type="text" size="mini" aria-label="上一个匹配" disabled={!search.matches.length} icon={<ArrowUp size={15}/>} onClick={() => selectMatch(editor, search.index - 1)}/>
          <Button type="text" size="mini" aria-label="下一个匹配" disabled={!search.matches.length} icon={<ArrowDown size={15}/>} onClick={() => selectMatch(editor, search.index + 1)}/>
          <Button type="text" size="mini" aria-label="关闭查找" icon={<X size={15}/>} onClick={closeFind}/>
        </div>
        <div className="editor-find-options"><Checkbox checked={sensitive} onChange={setSensitive}>区分大小写</Checkbox>{editable && <Button type="text" size="mini" onClick={() => setShowReplace(value => !value)}>{showReplace ? '收起替换' : '替换'}</Button>}</div>
        {showReplace && editable && <form className="editor-find-row" onSubmit={event => {event.preventDefault(); replace();}}>
          <input aria-label="替换为" placeholder="替换为（留空则删除）" maxLength={10_000} value={replacement} onChange={event => setReplacement(event.target.value)}/>
          <Button size="mini" htmlType="submit" disabled={!search.matches.length}>替换</Button><Button size="mini" disabled={!search.matches.length} onClick={() => replace(true)}>全部替换</Button>
        </form>}
      </div>}
      {outlineOpen && <aside className="editor-outline" aria-label="文档大纲"><div className="editor-outline-head"><span className="ico-label"><ListTree size={16}/>大纲</span><Button type="text" size="mini" aria-label="关闭大纲" icon={<X size={15}/>} onClick={() => setOutlineOpen(false)}/></div>
        <nav>{headings.length ? headings.map(item => <button key={item.position} style={{paddingLeft: 12 + (item.level - 1) * 12}} onClick={() => {
          editor.commands.setTextSelection(item.position + 1);
          const node = editor.view.nodeDOM(item.position);
          if (node instanceof HTMLElement) node.scrollIntoView({block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
          if (window.matchMedia('(max-width: 900px)').matches) setOutlineOpen(false);
        }}>{item.text}</button>) : <Empty description="添加标题后显示大纲"/>}</nav>
      </aside>}
      {focused && <Button className="editor-exit-focus" size="small" icon={<Minimize2 size={16}/>} onClick={() => setFocused(false)}>退出专注</Button>}
    </>, pane)}
    {slash && editable && !composing && createPortal(<div ref={slashPanel} id={slashId} className="editor-slash-menu" role="listbox" aria-label="快捷插入" style={slashPosition}>
      <div className="editor-slash-caption">插入内容</div>
      {options.length ? options.map((command, index) => <button type="button" key={command.key} role="option" aria-selected={index === Math.min(slash.index, options.length - 1)} tabIndex={-1} onMouseDown={event => event.preventDefault()} onClick={() => runInsert(editor, command)}><command.Icon size={16}/><span>{command.label}</span></button>) : <div className="editor-slash-empty">没有匹配的功能</div>}
    </div>, document.body)}
  </>;
}
