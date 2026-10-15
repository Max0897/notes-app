import type {ReactNode} from 'react';

export function ListRow({children, actions, className = ''}: {children: ReactNode; actions?: ReactNode; className?: string}) {
  return <article className={'list-row ' + className}>
    <div className="list-row-content">{children}</div>
    {actions && <div className="list-row-actions">{actions}</div>}
  </article>;
}
