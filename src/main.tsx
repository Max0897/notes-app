import {createRoot} from 'react-dom/client';
import {HintProvider} from './HintProvider';
import '@arco-design/web-react/dist/css/arco.css';
import './style.css';
import {App} from './App';
import {ImagePreview} from './ImagePreview';

createRoot(document.getElementById('root')!).render(<HintProvider><App/><ImagePreview/></HintProvider>);
