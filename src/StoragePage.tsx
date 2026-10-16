import type {Team, User} from './api';
import {StorageDetails} from './StorageUsage';
import {WorkspacePage} from './WorkspacePage';

export function StoragePage({user, team, onMenu}: {user: User; team?: Team; onMenu: () => void}) {
  return <WorkspacePage title="存储空间" onMenu={onMenu} className="storage-page">
    <StorageDetails key={team?.id ?? user.id} userId={user.id} teamId={team?.id}/>
  </WorkspacePage>;
}
