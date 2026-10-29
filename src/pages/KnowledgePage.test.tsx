import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppServicesProvider } from '../app/AppServicesContext';
import { ThemePreferencesProvider } from '../app/ThemePreferencesContext';
import { ConfirmProvider } from '../components/feedback/ConfirmProvider';
import { createUnavailableServices } from '../services/UnavailableServices';
import { KnowledgePage } from './KnowledgePage';

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('knowledge sources', () => {
  it('suggests discovered local services while keeping the URL editable', async () => {
    const services = createUnavailableServices();
    services.knowledge = { listSources: vi.fn().mockResolvedValue([]), saveSource: vi.fn(), discoverLocal: vi.fn().mockResolvedValue([{ kind: 'openwebui', baseUrl: 'http://127.0.0.1:8080', label: 'Open WebUI' }]) };
    render(<AppServicesProvider services={services}><ThemePreferencesProvider><ConfirmProvider><KnowledgePage /></ConfirmProvider></ThemePreferencesProvider></AppServicesProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check common local services' }));
    fireEvent.click(await screen.findByRole('button', { name: /Open WebUI ·/ }));
    expect(screen.getByRole('textbox', { name: 'Service URL' })).toHaveValue('http://127.0.0.1:8080');
  });
  it('connects to a saved source and displays its actual search results', async () => {
    const services = createUnavailableServices();
    const searchSource = vi.fn().mockResolvedValue([{ id: 'c1', documentId: 'd1', documentName: 'Notes.pdf', content: 'A real source passage', similarity: 0.9 }]);
    services.knowledge = {
      listSources: vi.fn().mockResolvedValue([{ id: 's1', name: 'Work', kind: 'ragflow', baseUrl: 'http://127.0.0.1:9380', hasApiKey: true }]),
      listSpaces: vi.fn().mockResolvedValue([{ id: 'k1', name: 'Team' }]),
      searchSource,
      saveSource: vi.fn(), removeSource: vi.fn(),
    };
    render(<AppServicesProvider services={services}><ThemePreferencesProvider><ConfirmProvider><KnowledgePage /></ConfirmProvider></ThemePreferencesProvider></AppServicesProvider>);
    expect(await screen.findByText('Work')).toBeInTheDocument();
    await screen.findByText('Team');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search knowledge' }), { target: { value: 'budget' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('A real source passage')).toBeInTheDocument();
    expect(screen.getByText('Notes.pdf')).toBeInTheDocument();
    expect(searchSource).toHaveBeenCalledWith('s1', 'k1', 'budget');
  });

  it('reports a connection failure instead of presenting it as an empty library', async () => {
    const services = createUnavailableServices();
    services.knowledge = {
      listSources: vi.fn().mockResolvedValue([{ id: 's1', name: 'Work', kind: 'ragflow', baseUrl: 'http://127.0.0.1:9380', hasApiKey: true }]),
      listSpaces: vi.fn().mockRejectedValue(new Error('Connection refused')),
      searchSource: vi.fn(), saveSource: vi.fn(), removeSource: vi.fn(),
    };
    render(<AppServicesProvider services={services}><ThemePreferencesProvider><ConfirmProvider><KnowledgePage /></ConfirmProvider></ThemePreferencesProvider></AppServicesProvider>);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Connection refused'));
    expect(screen.queryByText(/has no accessible knowledge spaces/)).not.toBeInTheDocument();
  });

  it('shows indexing status after a file is imported', async () => {
    const services = createUnavailableServices();
    const importFile = vi.fn().mockResolvedValue({ name: 'notes.txt', documentId: 'd1', status: 'submitted' });
    services.knowledge = {
      listSources: vi.fn().mockResolvedValue([{ id: 's1', name: 'Work', kind: 'ragflow', baseUrl: 'http://127.0.0.1:9380', hasApiKey: true }]),
      listSpaces: vi.fn().mockResolvedValue([{ id: 'k1', name: 'Team', usesPipeline: false }]),
      importFile, documentStatus: vi.fn().mockResolvedValue({ status: 'ready', message: '' }),
      listDocuments: vi.fn().mockResolvedValue({ items: [{ id: 'd1', name: 'notes.txt', status: 'ready', message: '' }], hasMore: false }),
    };
    render(<AppServicesProvider services={services}><ThemePreferencesProvider><ConfirmProvider><KnowledgePage /></ConfirmProvider></ThemePreferencesProvider></AppServicesProvider>);
    await screen.findByText('Team');
    fireEvent.click(screen.getByRole('button', { name: 'Import file' }));
    expect(await screen.findByText(/Uploaded; waiting/)).toBeInTheDocument();
    expect(await screen.findByText(/Indexed and searchable/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText('Indexed')).toBeInTheDocument();
    expect(importFile).toHaveBeenCalledWith('s1', 'k1');
  });

  it('shows MCP capabilities and only calls a selected tool after confirmation', async () => {
    const services = createUnavailableServices();
    const callMcpTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'found' }] });
    services.knowledge = {
      listSources: vi.fn().mockResolvedValue([{ id: 'm1', name: 'Shared MCP', kind: 'mcp', baseUrl: 'http://127.0.0.1:9382/mcp', hasApiKey: false }]),
      inspectMcp: vi.fn().mockResolvedValue({ serverName: 'Example', tools: [{ name: 'find', description: 'Search documents', inputSchema: { type: 'object' } }], resources: [] }),
      callMcpTool, saveSource: vi.fn(), removeSource: vi.fn(),
    };
    render(<AppServicesProvider services={services}><ThemePreferencesProvider><ConfirmProvider><KnowledgePage /></ConfirmProvider></ThemePreferencesProvider></AppServicesProvider>);
    await screen.findByText('Search documents');
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Select tool' }));
    fireEvent.click(screen.getByRole('option', { name: 'find' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Tool arguments (JSON)' }), { target: { value: '{"query":"budget"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run tool' }));
    expect(callMcpTool).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Run' }));
    await waitFor(() => expect(callMcpTool).toHaveBeenCalledWith('m1', 'find', { query: 'budget' }));
    expect(await screen.findByLabelText('Tool result')).toHaveTextContent('found');
  });
});
