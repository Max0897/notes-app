import {Button, Space, Tooltip} from '@arco-design/web-react';
import {Bold, Heading2, ImagePlus, Italic, List, ListChecks, ListOrdered, Redo2, Undo2} from 'lucide-react';
import type {Editor} from '@tiptap/react';
import {chooseImages} from './editorImages';

export function EditorTools({editor, disabled}: {editor: Editor | null; disabled: boolean}) {
  const tools = [
    {label: '标题', icon: <Heading2 size={16}/>, active: editor?.isActive('heading', {level: 2}), run: () => editor?.chain().focus().toggleHeading({level: 2}).run()},
    {label: '粗体', icon: <Bold size={16}/>, active: editor?.isActive('bold'), run: () => editor?.chain().focus().toggleBold().run()},
    {label: '斜体', icon: <Italic size={16}/>, active: editor?.isActive('italic'), run: () => editor?.chain().focus().toggleItalic().run()},
    {label: '无序列表', icon: <List size={16}/>, active: editor?.isActive('bulletList'), run: () => editor?.chain().focus().toggleBulletList().run()},
    {label: '有序列表', icon: <ListOrdered size={16}/>, active: editor?.isActive('orderedList'), run: () => editor?.chain().focus().toggleOrderedList().run()},
    {label: '待办清单', icon: <ListChecks size={16}/>, active: editor?.isActive('taskList'), run: () => editor?.chain().focus().toggleTaskList().run()},
    {label: '插入图片', icon: <ImagePlus size={16}/>, run: () => chooseImages(editor)},
    {label: '撤销', icon: <Undo2 size={16}/>, run: () => editor?.chain().focus().undo().run()},
    {label: '重做', icon: <Redo2 size={16}/>, run: () => editor?.chain().focus().redo().run()},
  ];
  return <Space className="format-tools" size={4}>{tools.map(tool => <Tooltip key={tool.label} content={tool.label}>
    <Button size="small" type={tool.active ? 'secondary' : 'text'} disabled={disabled} aria-label={tool.label} icon={tool.icon} onClick={tool.run}/>
  </Tooltip>)}</Space>;
}
