// 从富文本正文（Tiptap/ProseMirror JSON）中提取待办项，保留嵌套层级。
export type Todo = {text: string; checked: boolean; depth: number};
type Node = {type?: string; text?: string; attrs?: Record<string, unknown>; content?: Node[]};

function inline(node: Node): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return ' ';
  return (node.content ?? []).map(inline).join('');
}
const clip = (text: string) => { const chars = Array.from(text.replace(/\s+/g, ' ').trim()); return chars.length > 200 ? chars.slice(0, 200).join('') + '…' : chars.join(''); };

// 按文档顺序返回所有待办；子待办的 depth 比父待办大 1。
export function extractTodos(content: unknown): Todo[] {
  const todos: Todo[] = [];
  const walk = (node: Node, depth: number) => {
    if (node.type === 'taskItem') {
      const nested: Node[] = [], parts: Node[] = [];
      for (const child of node.content ?? []) (child.type === 'taskList' ? nested : parts).push(child);
      todos.push({text: clip(parts.map(inline).join(' ')), checked: node.attrs?.checked === true, depth});
      for (const list of nested) walk(list, depth + 1);
      return;
    }
    for (const child of node.content ?? []) walk(child, depth);
  };
  if (content && typeof content === 'object') walk(content as Node, 0);
  return todos;
}

// 仅保留未完成的待办；已勾选但仍有未完成子项的父项保留，以免子项失去上下文。
export function openTodos(todos: Todo[]): Todo[] {
  return todos.filter((todo, index) => {
    if (!todo.checked) return true;
    for (let next = index + 1; next < todos.length && todos[next].depth > todo.depth; next++) if (!todos[next].checked) return true;
    return false;
  });
}
