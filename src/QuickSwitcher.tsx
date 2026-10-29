import {useEffect, useMemo, useRef, useState, type KeyboardEvent} from 'react';
import {Empty, Input, Modal, Typography} from '@arco-design/web-react';
import {FileText, Search} from 'lucide-react';
import type {Folder, Note} from './api';
import {Highlight} from './Highlight';
import {rankNotes, snippet} from './noteSearch';

const {Text} = Typography;

export function QuickSwitcher({visible, notes, folders, currentId, onSelect, onClose}: {
  visible: boolean; notes: Note[]; folders: Folder[]; currentId: string | null; onSelect: (note: Note) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState(''), [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const results = useMemo(() => visible ? rankNotes(notes.filter(note => !note.deletedAt), query) : [], [visible, notes, query]);
  useEffect(() => { if (visible) { setQuery(''); setIndex(0); } }, [visible]);
  useEffect(() => { list.current?.querySelector('.quick-switcher-item.active')?.scrollIntoView({block: 'nearest'}); }, [index, results]);
  const keyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length) setIndex((index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
    } else if (event.key === 'Enter' && results[index]) { event.preventDefault(); onSelect(results[index]); }
  };
  const term = query.trim().split(/\s+/)[0] ?? '';
  return <Modal className="quick-switcher" visible={visible} title={null} footer={null} closable={false} onCancel={onClose} unmountOnExit autoFocus={false} style={{maxWidth: 'calc(100vw - 32px)'}}>
    <Input autoFocus allowClear prefix={<Search size={16}/>} placeholder="按标题或内容跳转到备忘录" aria-label="快速跳转" value={query} onKeyDown={keyDown}
      onChange={value => { setQuery(value); setIndex(0); }}/>
    <div className="quick-switcher-hint">{query.trim() ? '搜索结果' : '最近修改'}</div>
    <div className="quick-switcher-list" ref={list} role="listbox" aria-label="备忘录">
      {results.length ? results.map((note, i) => <div key={note.id} role="option" aria-selected={i === index} className={'quick-switcher-item' + (i === index ? ' active' : '')}
        onMouseMove={() => i !== index && setIndex(i)} onMouseDown={event => event.preventDefault()} onClick={() => onSelect(note)}>
        <FileText size={16}/>
        <div className="quick-switcher-text">
          <Text className="quick-switcher-title"><Highlight text={note.title || '新备忘录'} query={term}/></Text>
          <Text type="secondary" className="quick-switcher-desc">{folders.find(folder => folder.id === note.folderId)?.name ?? '未分类'} · <Highlight text={snippet(note.plainText, term) || '暂无内容'} query={term}/></Text>
        </div>
        {note.id === currentId && <Text type="secondary" className="quick-switcher-current">当前</Text>}
      </div>) : <Empty description="没有匹配的备忘录"/>}
    </div>
    <div className="quick-switcher-keys">↑↓ 选择 · Enter 打开 · Esc 关闭</div>
  </Modal>;
}
