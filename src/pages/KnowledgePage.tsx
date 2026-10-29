import { useCallback, useEffect, useRef, useState } from 'react';
import { AddOutlined, DeleteOutline, EditOutlined, FolderOpenOutlined, RefreshOutlined, SearchOutlined } from '@mui/icons-material';
import { Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, TextField } from '@mui/material';
import { useAppServices } from '../app/AppServicesContext';
import { useConfirm } from '../components/feedback/ConfirmProvider';
import { useI18n } from '../i18n/strings';
import type { KnowledgeDocumentPage, KnowledgeImport, KnowledgeMcpCatalog, KnowledgeResult, KnowledgeSource, KnowledgeSpace } from '../domain/contracts';
import { attachAssistantContext, ASSISTANT_CONTEXT_MIME, setAssistantPageContext } from '../services/AssistantEvents';
import '../styles/workspace-pages.css';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function KnowledgePage() {
  const { knowledge } = useAppServices();
  const confirm = useConfirm();
  const { locale, t } = useI18n();
  const zh = locale === 'zh-CN';
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [spaces, setSpaces] = useState<KnowledgeSpace[]>([]);
  const [catalog, setCatalog] = useState<KnowledgeMcpCatalog | null>(null);
  const [toolName, setToolName] = useState('');
  const [toolArgs, setToolArgs] = useState('{}');
  const [toolOutput, setToolOutput] = useState('');
  const [importJob, setImportJob] = useState<(KnowledgeImport & { sourceId: string; spaceId: string; message?: string }) | null>(null);
  const [documentPage, setDocumentPage] = useState(1);
  const [documents, setDocuments] = useState<KnowledgeDocumentPage | null>(null);
  const [documentError, setDocumentError] = useState('');
  const [documentRefresh, setDocumentRefresh] = useState(0);
  const [spaceId, setSpaceId] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KnowledgeResult[] | null>(null);
  const [loading, setLoading] = useState(Boolean(knowledge.listSources));
  const [spaceStatus, setSpaceStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ id?: string; name: string; kind: KnowledgeSource['kind']; baseUrl: string; apiKey: string }>({ name: '', kind: 'ragflow', baseUrl: 'http://127.0.0.1:9380', apiKey: '' });
  const [formError, setFormError] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<Array<{ kind: KnowledgeSource['kind']; baseUrl: string; label: string }> | null>(null);
  const generation = useRef(0);
  const selectedSource = sources.find((source) => source.id === sourceId);
  useEffect(() => {
    const space = spaces.find((item) => item.id === spaceId);
    setAssistantPageContext('/knowledge', `Source: ${selectedSource?.name ?? 'none'}; service type: ${selectedSource?.kind ?? 'none'}; knowledge space: ${space?.name ?? 'none'}; connection status: ${spaceStatus}; available MCP tools: ${catalog?.tools.map((tool) => tool.name).join(', ') || 'none'}.`);
  }, [selectedSource, spaces, spaceId, spaceStatus, catalog]);

  const loadSources = useCallback(async () => {
    if (!knowledge.listSources) return;
    setLoading(true);
    try {
      const found = await knowledge.listSources();
      setSources(found);
      setSourceId((current) => found.some((item) => item.id === current) ? current : found[0]?.id ?? '');
      setError('');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setLoading(false); }
  }, [knowledge]);

  useEffect(() => {
    let active = true;
    if (knowledge.listSources) void knowledge.listSources().then((found) => {
      if (!active) return;
      setSources(found); setSourceId(found[0]?.id ?? ''); setError('');
    }).catch((cause: unknown) => { if (active) setError(errorMessage(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [knowledge]);
  useEffect(() => {
    const current = ++generation.current;
    if (!sourceId || !selectedSource) return;
    // Defer the transition so the previous source cannot be used while this request runs.
    const timer = window.setTimeout(() => { if (current === generation.current) setSpaceStatus('loading'); }, 0);
    const request = selectedSource.kind === 'mcp'
      ? knowledge.inspectMcp?.(sourceId).then((value) => ({ catalog: value, spaces: [] as KnowledgeSpace[] }))
      : knowledge.listSpaces?.(sourceId).then((value) => ({ catalog: null, spaces: value }));
    if (!request) return;
    void request.then((value) => {
      if (current !== generation.current) return;
      window.clearTimeout(timer); setCatalog(value.catalog); setSpaces(value.spaces); setSpaceId(value.spaces[0]?.id ?? ''); setSpaceStatus('ready'); setError('');
    }).catch((cause: unknown) => { if (current === generation.current) { window.clearTimeout(timer); setSpaceStatus('error'); setError(errorMessage(cause)); } });
    return () => { window.clearTimeout(timer); generation.current += 1; };
  }, [knowledge, sourceId, selectedSource]);

  const refreshImport = useCallback(async (job: KnowledgeImport & { sourceId: string; spaceId: string }) => {
    if (!knowledge.documentStatus) return;
    try {
      const status = await knowledge.documentStatus(job.sourceId, job.spaceId, job.documentId);
      setImportJob((current) => current?.documentId === job.documentId && current.sourceId === job.sourceId ? { ...current, ...status } : current);
      if (['ready', 'failed', 'cancelled'].includes(status.status)) setDocumentRefresh((value) => value + 1);
    } catch (cause) {
      setImportJob((current) => current?.documentId === job.documentId && current.sourceId === job.sourceId ? { ...current, status: 'unknown', message: errorMessage(cause) } : current);
    }
  }, [knowledge]);
  useEffect(() => {
    if (!importJob || !['submitted', 'queued', 'processing'].includes(importJob.status)) return;
    const timer = window.setTimeout(() => void refreshImport(importJob), 2000);
    return () => window.clearTimeout(timer);
  }, [importJob, refreshImport]);
  useEffect(() => {
    if (selectedSource?.kind !== 'ragflow' || !spaceId || !knowledge.listDocuments || spaceStatus !== 'ready') return;
    let active = true;
    void knowledge.listDocuments(sourceId, spaceId, documentPage).then((page) => { if (active) { setDocuments(page); setDocumentError(''); } }).catch((cause: unknown) => { if (active) { setDocuments(null); setDocumentError(errorMessage(cause)); } });
    return () => { active = false; };
  }, [knowledge, selectedSource, sourceId, spaceId, spaceStatus, documentPage, documentRefresh]);
  useEffect(() => {
    if (!documents?.items.some((item) => item.status === 'queued' || item.status === 'processing')) return;
    const timer = window.setTimeout(() => setDocumentRefresh((value) => value + 1), 5000);
    return () => window.clearTimeout(timer);
  }, [documents]);

  const save = async () => {
    if (!knowledge.saveSource || busy) return;
    setBusy(true); setFormError('');
    try {
      const saved = await knowledge.saveSource(draft);
      setSources((current) => [...current.filter((item) => item.id !== saved.id), saved]); setSpaces([]); setCatalog(null); setSpaceId(''); setSpaceStatus('loading'); setResults(null); setDocuments(null); setDocumentError(''); setDocumentPage(1); setSourceId(saved.id);
      setDraft({ name: '', kind: 'ragflow', baseUrl: 'http://127.0.0.1:9380', apiKey: '' }); setOpen(false);
    } catch (cause) { setFormError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const search = async () => {
    if (!knowledge.searchSource || !sourceId || !spaceId || !query.trim() || busy) return;
    const current = generation.current;
    setBusy(true); setError(''); setResults(null);
    try {
      const found = await knowledge.searchSource(sourceId, spaceId, query.trim());
      if (current === generation.current) setResults(found);
    } catch (cause) { if (current === generation.current) setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const importFile = async () => {
    if (!knowledge.importFile || !sourceId || !spaceId || busy) return;
    const currentSource = sourceId; const currentSpace = spaceId;
    setBusy(true); setError('');
    try {
      const uploaded = await knowledge.importFile(currentSource, currentSpace);
      if (uploaded) { setImportJob({ ...uploaded, sourceId: currentSource, spaceId: currentSpace }); setDocumentPage(1); setDocumentRefresh((value) => value + 1); }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const refreshSource = async () => {
    if (!sourceId || !selectedSource) return;
    const current = ++generation.current;
    setSpaceStatus('loading'); setError('');
    try {
      if (selectedSource.kind === 'mcp' && knowledge.inspectMcp) {
        const value = await knowledge.inspectMcp(sourceId);
        if (current === generation.current) { setCatalog(value); setSpaceStatus('ready'); }
      } else if (knowledge.listSpaces) {
        const items = await knowledge.listSpaces(sourceId);
        if (current === generation.current) { setSpaces(items); setSpaceId((previous) => items.some((item) => item.id === previous) ? previous : items[0]?.id ?? ''); setSpaceStatus('ready'); }
      }
    } catch (cause) { if (current === generation.current) { setSpaceStatus('error'); setError(errorMessage(cause)); } }
  };
  const runMcpTool = async () => {
    if (!knowledge.callMcpTool || !sourceId || !toolName || busy) return;
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(toolArgs);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Arguments must be an object.');
      args = parsed as Record<string, unknown>;
    } catch {
      setError(zh ? '工具参数必须是有效的 JSON 对象。' : 'Tool arguments must be a valid JSON object.'); return;
    }
    if (!await confirm({ title: zh ? '执行 MCP 工具？' : 'Run MCP tool?', body: <><p>{toolName}</p><pre className="knowledge-json">{JSON.stringify(args, null, 2)}</pre></>, confirmLabel: zh ? '执行' : 'Run' })) return;
    const current = generation.current;
    setBusy(true); setError(''); setToolOutput('');
    try { const output = await knowledge.callMcpTool(sourceId, toolName, args); if (current === generation.current) setToolOutput(JSON.stringify(output, null, 2)); }
    catch (cause) { if (current === generation.current) setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!knowledge.removeSource || !sourceId) return;
    const selected = sources.find((source) => source.id === sourceId);
    if (!selected || !await confirm({
      title: zh ? '移除连接？' : 'Remove connection?',
      body: zh ? `只移除“${selected.name}”的连接设置，不会删除后端知识或文件。` : `Remove the connection to ${selected.name}. Documents in the service are not deleted.`,
      confirmLabel: zh ? '移除连接' : 'Remove connection', destructive: true,
    })) return;
    setBusy(true);
    try { await knowledge.removeSource(selected.id); await loadSources(); setSpaces([]); setResults(null); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };

  return <div className="page-stack">
    <header className="page-head">
      <div className="page-head-copy"><h1 className="page-title">{t('knowledgeTitle')}</h1><p className="page-sub">{zh ? '连接已有知识服务，搜索并查看原始来源。' : 'Connect a knowledge service, search it, and view source passages.'}</p></div>
      {knowledge.saveSource && <div className="page-head-actions"><Button variant="contained" startIcon={<AddOutlined />} onClick={() => { setFormError(''); setDiscovered(null); setDraft({ name: '', kind: 'ragflow', baseUrl: 'http://127.0.0.1:9380', apiKey: '' }); setOpen(true); }}>{zh ? '连接知识源' : 'Connect source'}</Button></div>}
    </header>

    {!knowledge.listSources ? <Alert severity="info">{zh ? '请使用 Windows 桌面版连接知识服务。' : 'Use the Windows desktop app to connect a knowledge service.'}</Alert> : <>
      {error && <Alert severity="error" onClose={sources.length ? () => setError('') : undefined} action={!sources.length ? <Button color="inherit" size="small" onClick={() => void loadSources()}>{t('refresh')}</Button> : undefined}>{error}</Alert>}
      {loading && <div className="loading-panel" role="status"><CircularProgress size={18} /> {t('loading')}</div>}
      {!loading && !error && sources.length === 0 && <section className="empty-state"><span className="empty-state-icon"><FolderOpenOutlined /></span><h2>{zh ? '尚未连接知识源' : 'No knowledge sources connected'}</h2><p>{zh ? '连接已有知识服务，查询其中的知识空间。' : 'Connect an existing knowledge service to search its knowledge spaces.'}</p></section>}
      {sources.length > 0 && <section className="panel knowledge-source-panel">
        <div className="knowledge-controls">
          <TextField select size="small" label={zh ? '知识源' : 'Source'} value={sourceId} onChange={(event) => { setSpaces([]); setCatalog(null); setToolName(''); setToolArgs('{}'); setToolOutput(''); setSpaceId(''); setSpaceStatus('loading'); setResults(null); setDocuments(null); setDocumentError(''); setDocumentPage(1); setSourceId(event.target.value); }}>
            {sources.map((source) => <MenuItem key={source.id} value={source.id}>{source.name}</MenuItem>)}
          </TextField>
          {selectedSource?.kind !== 'mcp' && <TextField select size="small" label={zh ? '知识空间' : 'Knowledge space'} value={spaceId} onChange={(event) => { setSpaceId(event.target.value); setResults(null); setDocuments(null); setDocumentError(''); setDocumentPage(1); }}>
            {spaces.map((space) => <MenuItem key={space.id} value={space.id}>{space.name}</MenuItem>)}
          </TextField>}
          <Button startIcon={<RefreshOutlined />} onClick={() => void refreshSource()}>{t('refresh')}</Button>
          {selectedSource && knowledge.saveSource && <Button startIcon={<EditOutlined />} onClick={() => { setDraft({ id: selectedSource.id, name: selectedSource.name, kind: selectedSource.kind, baseUrl: selectedSource.baseUrl, apiKey: '' }); setFormError(''); setOpen(true); }}>{zh ? '编辑连接' : 'Edit connection'}</Button>}
          {selectedSource?.kind === 'ragflow' && knowledge.importFile && <Button startIcon={<AddOutlined />} onClick={() => void importFile()} disabled={busy || !spaceId}>{zh ? '导入文件' : 'Import file'}</Button>}
          <Button color="error" startIcon={<DeleteOutline />} onClick={() => void remove()}>{zh ? '移除连接' : 'Remove connection'}</Button>
        </div>
        {importJob && importJob.sourceId === sourceId && importJob.spaceId === spaceId && <Alert severity={importJob.status === 'ready' ? 'success' : importJob.status === 'failed' || importJob.status === 'cancelled' || importJob.status === 'unknown' ? 'error' : 'info'} action={importJob.status === 'unknown' ? <Button color="inherit" size="small" onClick={() => void refreshImport(importJob)}>{t('refresh')}</Button> : undefined}>
          {importJob.name}: {importJob.status === 'ready' ? (zh ? '索引完成，可以搜索。' : 'Indexed and searchable.') : importJob.status === 'failed' ? (zh ? '索引失败，请在后端检查。' : 'Indexing failed; check the service.') : importJob.status === 'cancelled' ? (zh ? '索引已取消。' : 'Indexing was cancelled.') : importJob.status === 'unknown' ? (zh ? '无法确认索引状态。' : 'Could not confirm indexing status.') : (zh ? '已上传，正在等待后端索引…' : 'Uploaded; waiting for the service to index…')}{importJob.message ? ` ${importJob.message}` : ''}
        </Alert>}
        {spaceStatus === 'loading' && <p className="panel-caption" role="status">{zh ? '正在连接知识服务…' : 'Connecting to the knowledge service…'}</p>}
        {selectedSource?.kind === 'mcp' && catalog && <div className="knowledge-mcp"><p className="panel-caption">{zh ? `已连接 ${catalog.serverName}；以下是服务提供的工具和资源。` : `Connected to ${catalog.serverName}. Available tools and resources:`}</p><ul className="knowledge-results">{catalog.tools.map((tool) => <li key={tool.name}><strong>{tool.name}</strong><p>{tool.description}</p></li>)}{catalog.resources.map((resource) => <li key={resource.uri}><strong>{resource.name}</strong><p>{resource.uri}</p></li>)}</ul>
          {catalog.tools.length > 0 && knowledge.callMcpTool && <><TextField select size="small" label={zh ? '选择工具' : 'Select tool'} value={toolName} onChange={(event) => { setToolName(event.target.value); setToolOutput(''); }} fullWidth>{catalog.tools.map((tool) => <MenuItem key={tool.name} value={tool.name}>{tool.name}</MenuItem>)}</TextField>
            {toolName && <><details><summary>{zh ? '查看参数格式' : 'View parameter schema'}</summary><pre className="knowledge-json">{JSON.stringify(catalog.tools.find((tool) => tool.name === toolName)?.inputSchema, null, 2)}</pre></details><TextField label={zh ? '工具参数（JSON）' : 'Tool arguments (JSON)'} multiline minRows={3} value={toolArgs} onChange={(event) => setToolArgs(event.target.value)} fullWidth /><Button variant="outlined" onClick={() => void runMcpTool()} disabled={busy}>{zh ? '执行工具' : 'Run tool'}</Button></>}
            {toolOutput && <pre className="knowledge-json" aria-label={zh ? '工具结果' : 'Tool result'}>{toolOutput}</pre>}</>}
          {catalog.tools.length === 0 && catalog.resources.length === 0 && <p className="panel-caption">{zh ? '该服务没有公开工具或资源。' : 'This service exposes no tools or resources.'}</p>}
        </div>}
        {selectedSource?.kind !== 'mcp' && spaceStatus === 'ready' && spaces.length === 0 && <p className="panel-caption">{zh ? '这个知识源中没有可访问的知识空间。' : 'This source has no accessible knowledge spaces.'}</p>}
        {selectedSource?.kind === 'ragflow' && knowledge.listDocuments && spaceId && <section className="knowledge-documents" aria-label={zh ? '知识库文件' : 'Knowledge documents'}>
          <div className="knowledge-document-head"><strong>{zh ? '知识库文件' : 'Documents'}</strong><Button size="small" onClick={() => setDocumentRefresh((value) => value + 1)}>{t('refresh')}</Button></div>
          {documentError ? <Alert severity="error">{documentError}</Alert> : documents ? (documents.items.length ? <ul>{documents.items.map((item) => <li key={item.id}><span>{item.name}</span><span title={item.message}>{({ ready: zh ? '已索引' : 'Indexed', queued: zh ? '等待索引' : 'Queued', processing: zh ? '索引中' : 'Indexing', failed: zh ? '索引失败' : 'Failed', cancelled: zh ? '已取消' : 'Cancelled', unknown: zh ? '状态未知' : 'Unknown' } as const)[item.status]}</span></li>)}</ul> : <p className="panel-caption">{zh ? '此知识空间没有文件。' : 'No documents in this space.'}</p>) : <p className="panel-caption" role="status">{t('loading')}</p>}
          {(documentPage > 1 || documents?.hasMore) && <nav className="meeting-pagination" aria-label={zh ? '文件分页' : 'Document pages'}><Button size="small" disabled={documentPage === 1} onClick={() => { setDocuments(null); setDocumentPage((page) => page - 1); }}>{zh ? '上一页' : 'Previous'}</Button><span>{documentPage}</span><Button size="small" disabled={!documents?.hasMore} onClick={() => { setDocuments(null); setDocumentPage((page) => page + 1); }}>{zh ? '下一页' : 'Next'}</Button></nav>}
        </section>}
        {selectedSource?.kind !== 'mcp' && <form className="knowledge-search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
          <TextField fullWidth size="small" label={zh ? '搜索知识' : 'Search knowledge'} value={query} onChange={(event) => setQuery(event.target.value)} />
          <Button type="submit" variant="contained" startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <SearchOutlined />} disabled={busy || !spaceId || !query.trim()}>{zh ? '搜索' : 'Search'}</Button>
        </form>}
        {results && (results.length === 0 ? <p className="panel-caption">{zh ? '没有找到匹配内容。' : 'No matching passages found.'}</p> : <ul className="knowledge-results">{results.map((result, index) => {
          const context = `${selectedSource?.name ?? ''} / ${result.documentName}\n${result.content}`;
          return <li key={`${result.id}-${index}`} draggable onDragStart={(event) => { event.dataTransfer.setData(ASSISTANT_CONTEXT_MIME, context); event.dataTransfer.effectAllowed = 'copy'; }}><strong>{result.documentName}</strong><p>{result.content}</p><Button size="small" onClick={() => attachAssistantContext({ text: context })}>{zh ? '加入助手上下文' : 'Add to assistant context'}</Button></li>;
        })}</ul>)}
      </section>}
    </>}

    <Dialog open={open} onClose={busy ? undefined : () => setOpen(false)} fullWidth maxWidth="sm">
      <DialogTitle>{draft.id ? (zh ? '编辑知识源' : 'Edit knowledge source') : (zh ? '连接知识源' : 'Connect a knowledge source')}</DialogTitle>
      <DialogContent className="knowledge-source-dialog">
        <p className="panel-caption">{zh ? '文件继续保存在所连接的服务中。' : 'Files remain in the connected service.'}</p>
        {!draft.id && knowledge.discoverLocal && <><div><Button size="small" disabled={discovering} onClick={() => { setDiscovering(true); setFormError(''); void knowledge.discoverLocal!().then(setDiscovered).catch((cause: unknown) => setFormError(errorMessage(cause))).finally(() => setDiscovering(false)); }}>{discovering ? (zh ? '正在检测…' : 'Checking…') : (zh ? '检测本机常见服务' : 'Check common local services')}</Button></div>{discovered && (discovered.length ? <div className="knowledge-discovery">{discovered.map((item) => <Button key={`${item.kind}-${item.baseUrl}`} variant="outlined" size="small" onClick={() => setDraft((value) => ({ ...value, name: item.label, kind: item.kind, baseUrl: item.baseUrl, apiKey: '' }))}>{item.label} · {item.baseUrl}</Button>)}</div> : <p className="panel-caption">{zh ? '常见端口未发现服务；仍可手动输入其他地址或 MCP 服务。' : 'No service found on common ports. You can enter another address or MCP service manually.'}</p>)}</>}
        {formError && <Alert severity="error">{formError}</Alert>}
        <TextField select label={zh ? '服务类型' : 'Service type'} value={draft.kind} onChange={(event) => { const kind = event.target.value as KnowledgeSource['kind']; setDraft((value) => ({ ...value, kind, baseUrl: kind === 'ragflow' ? 'http://127.0.0.1:9380' : kind === 'openwebui' ? 'http://127.0.0.1:8080' : kind === 'mcp' ? 'http://127.0.0.1:9382/mcp' : 'http://127.0.0.1:3001' })); }} fullWidth>
          <MenuItem value="ragflow">RAGFlow</MenuItem><MenuItem value="openwebui">Open WebUI</MenuItem><MenuItem value="anythingllm">AnythingLLM</MenuItem><MenuItem value="mcp">MCP (Streamable HTTP)</MenuItem>
        </TextField>
        <TextField label={zh ? '连接名称' : 'Connection name'} value={draft.name} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} fullWidth />
        <TextField label={zh ? '服务地址' : 'Service URL'} value={draft.baseUrl} onChange={(event) => setDraft((value) => ({ ...value, baseUrl: event.target.value }))} fullWidth />
        <TextField label="API key" type="password" autoComplete="new-password" value={draft.apiKey} onChange={(event) => setDraft((value) => ({ ...value, apiKey: event.target.value }))} helperText={draft.id ? (zh ? '地址和类型不变时留空可保留密钥；更改地址或类型需重新输入。' : 'Leave blank to keep the key when the URL and type are unchanged; changing either requires a new key.') : (zh ? '密钥由 Windows 加密保存在当前用户账户中。' : 'The key is encrypted for the current Windows user.')} fullWidth />
      </DialogContent>
      <DialogActions><Button onClick={() => { setOpen(false); setDraft((value) => ({ ...value, apiKey: '' })); }} disabled={busy}>{t('cancel')}</Button><Button variant="contained" onClick={() => void save()} disabled={busy || !draft.name.trim() || !draft.baseUrl.trim() || (draft.kind !== 'mcp' && !draft.apiKey.trim() && !(draft.id && selectedSource?.id === draft.id && selectedSource.hasApiKey && selectedSource.kind === draft.kind && selectedSource.baseUrl === draft.baseUrl))}>{zh ? '保存连接' : 'Save connection'}</Button></DialogActions>
    </Dialog>
  </div>;
}
