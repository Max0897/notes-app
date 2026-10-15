import type {ReactNode} from 'react';
import {ConfigProvider} from '@arco-design/web-react';
import {useMobileHints} from './hints';

export function HintProvider({children}: {children: ReactNode}) {
  const mobile = useMobileHints();
  return <ConfigProvider componentConfig={{Tooltip: mobile ? {disabled: true, popupVisible: false} : {}}}>{children}</ConfigProvider>;
}
