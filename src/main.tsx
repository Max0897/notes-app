import {createRoot} from 'react-dom/client';
import {HintProvider} from './HintProvider';
import '@arco-design/web-react/dist/css/arco.css';
import './style.css';
import {createBrowserRouter, RouterProvider} from 'react-router-dom';
import {appRoutes} from './routes';
import {ImagePreview} from './ImagePreview';

const router = createBrowserRouter(appRoutes);
createRoot(document.getElementById('root')!).render(<HintProvider><RouterProvider router={router}/><ImagePreview/></HintProvider>);
