import type {ReactNode} from 'react';
import {Navigate, useLocation, useOutletContext, useParams} from 'react-router-dom';
import {pagePath, pageTabs, workspaceTeam, type WorkspaceView} from './navigation';

export function WorkspaceRoute({page}: {page: WorkspaceView}) {
  const content = useOutletContext<Record<WorkspaceView, ReactNode>>();
  const {tab, teamId} = useParams(), location = useLocation();
  if (page === 'account' || page === 'settings' || page === 'invitations') {
    if (!tab || !(pageTabs[page] as readonly string[]).includes(tab)) {
      return <Navigate replace to={pagePath(page, workspaceTeam(location.search, location.hash, teamId)) + location.hash}/>;
    }
  }
  return content[page];
}
