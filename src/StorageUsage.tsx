import {formatBytes, useStorageUsage, type StorageUsage} from './storage';
function CapacityBar({used, limit, label}: {used: number; limit: number; label: string}) {
  const percent = limit > 0 ? used / limit * 100 : 100;
  return <div className={'capacity-track ' + (percent >= 100 ? 'is-full' : percent >= 80 ? 'is-warning' : '')} role="progressbar" aria-label={label}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(percent))} aria-valuetext={formatBytes(used) + ' / ' + formatBytes(limit)}>
    <span style={{width: Math.max(0, Math.min(100, percent)) + '%'}}/>
  </div>;
}
export function SidebarStorage({data, error, team, active, disabled, onClick}: {data: StorageUsage | null; error: boolean; team: boolean; active?: boolean; disabled?: boolean; onClick: () => void}) {
  return <button type="button" className="sidebar-storage" aria-label={'查看' + (team ? '团队' : '个人') + '存储空间'} aria-current={active ? 'page' : undefined} disabled={disabled} onClick={onClick}>
    <span className="capacity-summary"><span>存储空间</span><span>{data ? formatBytes(data.usedBytes) + ' / ' + formatBytes(data.limitBytes) : error ? '用量暂不可用' : '读取中…'}</span></span>
    {data ? <CapacityBar used={data.usedBytes} limit={data.limitBytes} label={(team ? '团队' : '个人') + '存储用量'}/> : <span className="capacity-track"/>}
  </button>;
}
export function StorageDetails({userId, teamId = null}: {userId: string; teamId?: string | null}) {
  const {data, error, retry} = useStorageUsage(userId, teamId);
  return <section className="storage-details" aria-label={teamId ? '团队存储空间' : '个人存储空间'}>
    <div className="storage-heading">{teamId ? '团队存储空间' : '个人存储空间'}</div>
    {!data ? <div className="storage-note">{error ? <>用量暂不可用，<button type="button" className="storage-retry" onClick={retry}>重试</button></> : '正在读取用量…'}</div> : <>
      <div className="storage-metric"><span>图片占用 · {data.imageCount} 张</span><span>{formatBytes(data.usedBytes)} / {formatBytes(data.limitBytes)}</span></div>
      <CapacityBar used={data.usedBytes} limit={data.limitBytes} label="图片存储用量"/>
      {data.usedBytes >= data.limitBytes && <p className="storage-note storage-danger">存储空间已满，暂时无法上传新图片。</p>}
      <div className="storage-metric storage-daily"><span>{teamId ? '团队今日上传' : '今日上传（所有空间）'}</span><span>{formatBytes(data.today.usedBytes)} / {formatBytes(data.today.limitBytes)}</span></div>
      {teamId && <div className="storage-metric"><span>我今日上传（所有空间）</span><span>{formatBytes(data.today.userUsedBytes)} / {formatBytes(data.today.userLimitBytes)}</span></div>}
      <p className="storage-note">每日额度于北京时间 00:00 恢复。历史版本、最近删除和待清理的图片仍占用容量，文件实际清理后释放；同一图片的多次引用只计一次。</p>
      {error && <p className="storage-note">用量更新失败，<button type="button" className="storage-retry" onClick={retry}>重试</button></p>}
    </>}
  </section>;
}
