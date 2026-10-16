import type {Node} from '@tiptap/pm/model';

export function documentOutline(doc: Node) {
  const headings: {position: number; level: number; text: string}[] = [];
  doc.descendants((node, position) => {
    if (node.type.name === 'heading') headings.push({position, level: node.attrs.level, text: node.textContent || '未命名标题'});
  });
  return headings;
}
