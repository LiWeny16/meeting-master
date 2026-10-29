import { useEffect, useState } from 'react';
import { AddOutlined, FolderOpenOutlined, ShieldOutlined } from '@mui/icons-material';
import { Alert, Button, Snackbar } from '@mui/material';
import { useAppServices } from '../app/AppServicesContext';
import { useI18n } from '../i18n/strings';
import { useToast } from '../components/feedback/ToastProvider';
import '../styles/workspace-pages.css';

export function KnowledgePage() {
  const services = useAppServices();
  const { t } = useI18n();
  const toast = useToast();
  const [entriesCount, setEntriesCount] = useState(0);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let alive = true;
    void services.knowledge
      .list()
      .then((entries) => { if (alive) setEntriesCount(entries.length); })
      .catch((error: unknown) => {
        if (!alive) return;
        toast.show({
          tone: 'error',
          title: t('knowledgeTitle'),
          detail: error instanceof Error ? error.message : t('capabilityNotConnected'),
        });
      });
    return () => { alive = false; };
  }, [services, t, toast]);
  const explainImport = async () => {
    const result = await services.knowledge.importUnavailable();
    setNotice(result.message);
  };

  return (
    <div className="page-stack">
      <header className="page-head">
        <div className="page-head-copy">
          <h1 className="page-title">{t('knowledgeTitle')}</h1>
          <p className="page-sub">{t('noKnowledgeDetail')}</p>
        </div>
      </header>

      <div className="panel-subtle knowledge-note">
        <ShieldOutlined aria-hidden="true" />
        <p>{t('localOnly')}</p>
      </div>

      {entriesCount === 0 ? (
        <section className="empty-state">
          <span className="empty-state-icon"><FolderOpenOutlined aria-hidden="true" /></span>
          <h2>{t('noKnowledge')}</h2>
          <Button variant="contained" startIcon={<AddOutlined />} onClick={() => void explainImport()}>
            {t('addKnowledge')}
          </Button>
        </section>
      ) : (
        <div className="meta-line knowledge-stat">
          <span className="meta-item">
            <FolderOpenOutlined aria-hidden="true" />
            <span>{t('knowledgeTitle')} · <strong>{entriesCount}</strong></span>
          </span>
        </div>
      )}

      <Snackbar open={Boolean(notice)} autoHideDuration={4500} onClose={() => setNotice('')}>
        <Alert severity="info" onClose={() => setNotice('')}>{notice}</Alert>
      </Snackbar>
    </div>
  );
}
