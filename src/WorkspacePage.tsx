import type {ReactNode} from 'react';
import {Button, Typography} from '@arco-design/web-react';
import {Menu} from 'lucide-react';

export function WorkspacePage({title, onMenu, children, className = '', loading = false}: {
  title: string; onMenu: () => void; children: ReactNode; className?: string; loading?: boolean;
}) {
  return <main className={'workspace-page ' + className} aria-label={title}>
    <header className="workspace-header">
      <div className="workspace-heading"><Button className="mobile-nav-button" type="text" aria-label="打开文件夹与账号" icon={<Menu size={20}/>} onClick={onMenu}/><Typography.Title heading={5} style={{margin: 0}}>{title}</Typography.Title></div>
    </header>
    <div className="workspace-scroll" aria-busy={loading}><div className="workspace-content">{children}</div></div>
  </main>;
}
