import {Navigate, type RouteObject} from 'react-router-dom';
import {App} from './App';
import {WorkspaceRoute} from './WorkspaceRoute';

export const appRoutes: RouteObject[] = [{
  path: '/', Component: App,
  children: [
    {index: true, element: <WorkspaceRoute page="notes"/>, handle: {page: 'notes'}},
    {path: 'notes', element: <WorkspaceRoute page="notes"/>, handle: {page: 'notes'}},
    {path: 'account/:tab?', element: <WorkspaceRoute page="account"/>, handle: {page: 'account'}},
    {path: 'notifications', element: <WorkspaceRoute page="notifications"/>, handle: {page: 'notifications'}},
    {path: 'invitations/:tab?', element: <WorkspaceRoute page="invitations"/>, handle: {page: 'invitations'}},
    {path: 'storage', element: <WorkspaceRoute page="storage"/>, handle: {page: 'storage'}},
    {path: 'teams/:teamId/settings/:tab?', element: <WorkspaceRoute page="settings"/>, handle: {page: 'settings'}},
    {path: '*', element: <Navigate to="/notes" replace/>, handle: {page: 'notes'}},
  ],
}];
