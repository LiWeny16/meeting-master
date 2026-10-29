import { useEffect, useState } from 'react';
import AddOutlined from '@mui/icons-material/AddOutlined';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import EditOutlined from '@mui/icons-material/EditOutlined';
import GroupsOutlined from '@mui/icons-material/GroupsOutlined';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField } from '@mui/material';
import type { MeetingIdentity } from '../domain/contracts';
import { useAppServices } from '../app/AppServicesContext';
import { useI18n } from '../i18n/strings';
import { useConfirm } from '../components/feedback/ConfirmProvider';
import { ErrorState } from '../components/feedback/ErrorState';
import { attachAssistantContext, ASSISTANT_CONTEXT_MIME } from '../services/AssistantEvents';
import '../styles/workspace-pages.css';

export function IdentitiesPage() {
  const services = useAppServices();
  const { locale, t } = useI18n();
  const zh = locale === 'zh-CN';
  const confirm = useConfirm();
  const [profiles, setProfiles] = useState<MeetingIdentity[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [draft, setDraft] = useState<MeetingIdentity | null>(null);
  const [goals, setGoals] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  useEffect(() => {
    let alive = true;
    void services.identities.list().then((items) => { if (alive) { setProfiles(items); setLoading(false); } }).catch((error: unknown) => {
      if (alive) { setFailure(error instanceof Error ? error.message : String(error)); setLoading(false); }
    });
    return () => { alive = false; };
  }, [services, reloadKey]);

  const edit = (profile?: MeetingIdentity) => {
    const next = profile ?? { id: crypto.randomUUID(), name: '', role: '', context: '', goals: [], tone: '', guardrails: '', initials: '' };
    setDraft(next); setGoals(next.goals.join('\n')); setFormError('');
  };
  const save = async () => {
    if (!draft || busy) return;
    setBusy(true); setFormError('');
    const profile = { ...draft, goals: goals.split('\n').map((goal) => goal.trim()).filter(Boolean) };
    try { await services.identities.save(profile); setProfiles(await services.identities.list()); setDraft(null); }
    catch (error) { setFormError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const remove = async (profile: MeetingIdentity) => {
    if (!services.identities.remove || busy || !await confirm({ title: zh ? '删除身份？' : 'Delete identity?', body: zh ? `删除“${profile.name}”后，关联会议将不再使用此身份。` : `Meetings linked to ${profile.name} will no longer use this identity.`, confirmLabel: zh ? '删除' : 'Delete', destructive: true })) return;
    setBusy(true);
    try { await services.identities.remove(profile.id); setProfiles(await services.identities.list()); }
    catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const contextFor = (profile: MeetingIdentity) => [profile.name, profile.role, profile.context, ...profile.goals, profile.tone, profile.guardrails].filter(Boolean).join('\n');

  return <div className="page-stack">
    <header className="page-head"><div className="page-head-copy"><h1 className="page-title">{t('identitiesTitle')}</h1><p className="page-sub">{zh ? '创建会议角色，并在会议中或助手对话中使用。' : 'Create roles for meetings or attach them to an assistant conversation.'}</p></div>
      {services.identities.remove && <div className="page-head-actions"><Button variant="contained" startIcon={<AddOutlined />} onClick={() => edit()}>{zh ? '新建身份' : 'New identity'}</Button></div>}</header>
    {loading ? <div className="loading-panel" role="status">{t('loading')}</div> : failure ? <ErrorState title={t('identitiesTitle')} detail={failure} onRetry={() => { setFailure(''); setLoading(true); setReloadKey((key) => key + 1); }} /> : profiles.length === 0 ? <section className="empty-state"><span className="empty-state-icon"><GroupsOutlined aria-hidden="true" /></span><h2>{t('noIdentities')}</h2></section> : <ul className="row-list identity-list">
      {profiles.map((profile) => <li key={profile.id} className="list-row" draggable onDragStart={(event) => { event.dataTransfer.setData(ASSISTANT_CONTEXT_MIME, contextFor(profile)); event.dataTransfer.effectAllowed = 'copy'; }}>
        <span className="identity-monogram" aria-hidden="true">{profile.name.trim().slice(0, 1).toLocaleUpperCase()}</span><div className="list-row-main"><span className="list-row-title">{profile.name}</span><span className="identity-role">{profile.role}</span>{profile.goals.length > 0 && <span className="list-row-detail">{profile.goals.join(' · ')}</span>}</div>
        <div><Button size="small" onClick={() => attachAssistantContext({ text: contextFor(profile) })}>{zh ? '加入助手' : 'Add to assistant'}</Button>{services.identities.remove && <><Button size="small" startIcon={<EditOutlined />} onClick={() => edit(profile)} disabled={busy}>{zh ? '编辑' : 'Edit'}</Button><Button size="small" color="error" startIcon={<DeleteOutline />} onClick={() => void remove(profile)} disabled={busy}>{zh ? '删除' : 'Delete'}</Button></>}</div>
      </li>)}
    </ul>}
    <Dialog open={Boolean(draft)} onClose={busy ? undefined : () => setDraft(null)} fullWidth maxWidth="sm"><DialogTitle>{zh ? '编辑身份' : 'Edit identity'}</DialogTitle><DialogContent className="knowledge-source-dialog">
      {formError && <Alert severity="error">{formError}</Alert>}
      {draft && <><TextField label={zh ? '名称' : 'Name'} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required fullWidth /><TextField label={zh ? '角色定位' : 'Role'} value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} fullWidth /><TextField label={zh ? '背景' : 'Background'} value={draft.context} onChange={(e) => setDraft({ ...draft, context: e.target.value })} multiline minRows={2} fullWidth /><TextField label={zh ? '目标（每行一项）' : 'Goals (one per line)'} value={goals} onChange={(e) => setGoals(e.target.value)} multiline minRows={2} fullWidth /><TextField label={zh ? '语气' : 'Tone'} value={draft.tone} onChange={(e) => setDraft({ ...draft, tone: e.target.value })} fullWidth /><TextField label={zh ? '约束' : 'Guardrails'} value={draft.guardrails} onChange={(e) => setDraft({ ...draft, guardrails: e.target.value })} multiline minRows={2} fullWidth /></>}
    </DialogContent><DialogActions><Button onClick={() => setDraft(null)} disabled={busy}>{zh ? '取消' : 'Cancel'}</Button><Button variant="contained" onClick={() => void save()} disabled={busy || !draft?.name.trim()}>{zh ? '保存' : 'Save'}</Button></DialogActions></Dialog>
  </div>;
}
