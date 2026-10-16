import {Button, Dropdown, Menu, Space, Tooltip} from '@arco-design/web-react';
import {Bold, Heading2, Italic, List, ListChecks, ListOrdered, Plus, Redo2, Table2, Undo2} from 'lucide-react';
import {useEditorState, type Editor} from '@tiptap/react';
import {EditorFeatures} from './EditorFeatures';
import {insertCommands, runInsert} from './editorSlash';
import {tableActions, tableActionDisabled} from './editorTable';
import {useEditorEditable} from './editorState';

const insertMenuCommands = insertCommands.filter(command => ['image', 'table', 'quote', 'code', 'rule'].includes(command.key));

export function EditorTools({editor, disabled: locked, onComment}: {editor: Editor | null; disabled: boolean; onComment?: () => void}) {
  useEditorState({editor, selector: ({transactionNumber}) => transactionNumber});
  const editable = useEditorEditable(editor), disabled = locked || !editable;
  const tools = [
    {label: '粗体', icon: <Bold size={16}/>, active: editor?.isActive('bold'), run: () => editor?.chain().focus().toggleBold().run()},
    {label: '斜体', icon: <Italic size={16}/>, active: editor?.isActive('italic'), run: () => editor?.chain().focus().toggleItalic().run()},
    {label: '无序列表', icon: <List size={16}/>, active: editor?.isActive('bulletList'), run: () => editor?.chain().focus().toggleBulletList().run()},
    {label: '有序列表', icon: <ListOrdered size={16}/>, active: editor?.isActive('orderedList'), run: () => editor?.chain().focus().toggleOrderedList().run()},
    {label: '待办清单', icon: <ListChecks size={16}/>, active: editor?.isActive('taskList'), run: () => editor?.chain().focus().toggleTaskList().run()},
    {label: '撤销', icon: <Undo2 size={16}/>, run: () => editor?.chain().focus().undo().run()},
    {label: '重做', icon: <Redo2 size={16}/>, run: () => editor?.chain().focus().redo().run()},
  ];
  return <><Space className="format-tools" size={4}>
    <Dropdown trigger="click" position="bl" droplist={<Menu onClickMenuItem={key => {
      const level = Number(key);
      if (!disabled && editor?.isEditable) {
        if (level) editor.chain().focus().setHeading({level: level as 1 | 2 | 3}).run();
        else editor.chain().focus().setParagraph().run();
      }
    }}><Menu.Item key="0">正文</Menu.Item>{[1, 2, 3].map(level => <Menu.Item key={String(level)}>{level} 级标题</Menu.Item>)}</Menu>}>
      <Button size="small" disabled={disabled} aria-label="标题" type={editor?.isActive('heading') ? 'secondary' : 'text'} icon={<Heading2 size={16}/>}/>
    </Dropdown>
    {tools.map(tool => <Tooltip key={tool.label} content={tool.label}>
    <Button size="small" type={tool.active ? 'secondary' : 'text'} disabled={disabled} aria-label={tool.label} icon={tool.icon} onClick={tool.run}/>
  </Tooltip>)}
    <Dropdown trigger="click" position="bl" droplist={<Menu style={{maxHeight: 'min(440px, calc(100dvh - 100px))'}} onClickMenuItem={key => {
      const command = insertMenuCommands.find(item => item.key === key);
      if (editor && !disabled && command) runInsert(editor, command, null);
    }}>{insertMenuCommands.map(command => <Menu.Item key={command.key}><span className="ico-label"><command.Icon size={16}/><span>{command.label}</span></span></Menu.Item>)}</Menu>}>
      <Button size="small" type="text" disabled={disabled} aria-label="插入内容" icon={<Plus size={16}/>}/>
    </Dropdown>
    {editor?.isActive('table') && <Dropdown trigger="click" position="bl" droplist={<Menu onClickMenuItem={key => {
      const action = tableActions.find(item => item.key === key);
      if (action && !disabled && !tableActionDisabled(editor, action)) action.run(editor);
    }}>{tableActions.map(action => <Menu.Item key={action.key} disabled={disabled || tableActionDisabled(editor, action)}>{action.label}</Menu.Item>)}</Menu>}>
      <Button size="small" type="secondary" disabled={disabled} aria-label="表格操作" icon={<Table2 size={16}/>}/>
    </Dropdown>}
  </Space>{editor && <EditorFeatures editor={editor} onComment={onComment}/>}</>;
}
