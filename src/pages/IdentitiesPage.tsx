import { useEffect, useState } from 'react';
import { GroupsOutlined } from '@mui/icons-material';
import type { MeetingIdentity } from '../domain/contracts';
import { useAppServices } from '../app/AppServicesContext';
import { useI18n } from '../i18n/strings';
import { ErrorState } from '../components/feedback/ErrorState';
import '../styles/workspace-pages.css';

export function IdentitiesPage() {
  const services = useAppServices();
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<MeetingIdentity[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let alive = true;
    void services.identities
      .list()
      .then((items) => { if (alive) { setProfiles(items); setLoading(false); } })
      .catch((error: unknown) => {
        if (!alive) return;
        setFailure(error instanceof Error ? error.message : t('capabilityNotConnected'));
        setLoading(false);
      });
    return () => { alive = false; };
  }, [services, t, reloadKey]);

  return (
    <div className="page-stack">
      <header className="page-head">
        <div className="page-head-copy">
          <h1 className="page-title">{t('identitiesTitle')}</h1>
          <p className="page-sub">{t('noIdentitiesDetail')}</p>
        </div>
      </header>

      {loading ? (
        <div className="loading-panel" role="status">{t('loading')}</div>
      ) : failure ? (
        <ErrorState title={t('identitiesTitle')} detail={failure} onRetry={() => { setFailure(''); setLoading(true); setReloadKey((key) => key + 1); }} />
      ) : profiles.length === 0 ? (
        <section className="empty-state">
          <span className="empty-state-icon"><GroupsOutlined aria-hidden="true" /></span>
          <h2>{t('noIdentities')}</h2>
        </section>
      ) : (
        <ul className="row-list identity-list">
          {profiles.map((profile) => (
            <li key={profile.id} className="list-row">
              <span className="identity-monogram" aria-hidden="true">
                {profile.name.trim().slice(0, 1).toLocaleUpperCase()}
              </span>
              <div className="list-row-main">
                <span className="list-row-title">{profile.name}</span>
                <span className="identity-role">{profile.role}</span>
                {profile.goals.length > 0 && <span className="list-row-detail">{profile.goals.join(' · ')}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
