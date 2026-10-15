import {useEffect, useState} from 'react';
import {Button} from '@arco-design/web-react';
import {Check, Clock3} from 'lucide-react';
import {useHintTitle} from './hints';

export function SaveStatus({status, saved, onSave, pendingLabel = '保存中…'}: {status: string; saved: boolean; onSave: () => unknown; pendingLabel?: string}) {
  const [settled, setSettled] = useState(saved);
  useEffect(() => {
    // Wait for a quiet interval before returning to saved during continuous typing.
    const timer = setTimeout(() => setSettled(saved), saved ? 600 : 0);
    return () => clearTimeout(timer);
  }, [saved]);
  const complete = saved && settled;
  const label = saved && !settled ? pendingLabel : status;
  const title = useHintTitle(label + ' · 立即保存（Ctrl / ⌘ + S）');
  return <Button title={title} className="save-status" type="text" size="mini" onClick={() => void onSave()} icon={complete ? <Check size={14}/> : <Clock3 size={14}/>}>
    <span aria-live="polite">{label}</span>
  </Button>;
}
