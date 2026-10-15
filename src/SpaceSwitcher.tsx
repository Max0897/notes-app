import {Select} from '@arco-design/web-react';
import {Plus, Users} from 'lucide-react';
import type {Team} from './api';
export function SpaceSwitcher({teamId, teams, disabled, onSwitch, onCreate}: {
  teamId: string | null; teams: Team[]; disabled: boolean; onSwitch: (id: string | null) => void;
  onCreate: () => void;
}) {
  return <div className="space-switcher">
    <Select aria-label="切换个人或团队空间" value={teamId ?? ''} disabled={disabled} onChange={value => {
      if (value === 'create-team') onCreate();
      else onSwitch(value || null);
    }}>
      <Select.Option value="">个人空间</Select.Option>{teams.filter(t => !t.deletedAt).map(t => <Select.Option key={t.id} value={t.id}><span className="ico-label"><Users size={14}/><span>{t.name}</span></span></Select.Option>)}
      <Select.Option value="create-team"><span className="ico-label"><Plus size={14}/><span>创建团队</span></span></Select.Option>
    </Select>
  </div>;
}
