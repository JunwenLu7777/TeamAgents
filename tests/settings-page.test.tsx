// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentDefinition, AgentLibrary } from '../src/library-model.js';
import { MAX_LIBRARY_AGENTS } from '../src/library-model.js';
import type { AgentLibraryActions } from '../src/settings-contract.js';
import { settingsEn, settingsLocales, settingsZh, type SettingsTranslate } from '../src/settings-locales.js';
import { TeamSettingsPage, type TeamSettingsPageProps } from '../src/settings-page.js';

afterEach(cleanup);
const options = [
  { provider: 'deepseek', model: 'same-id', providerLabel: 'DeepSeek', modelLabel: 'Configured DeepSeek' },
  { provider: 'subscription', model: 'same-id', providerLabel: 'Subscription', modelLabel: 'Configured subscription' },
];
const translate = (language: 'en' | 'zh' = 'en'): SettingsTranslate => (key, params = {}) =>
  settingsLocales[language][key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
const agent = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({ name: 'architect', role: 'Architect', instructions: 'Inspect module boundaries.', enabled: true, ...overrides });
const library = (overrides: Partial<AgentLibrary> = {}): AgentLibrary => ({ revision: 7, agents: [agent()], updatedAt: '2026-01-01T00:00:00.000Z', ...overrides });
const empty = (): AgentLibrary => ({ revision: 0, agents: [], updatedAt: null });
function mockActions(snapshot = library()) {
  return {
    read: vi.fn<AgentLibraryActions['read']>().mockResolvedValue(snapshot),
    models: vi.fn<AgentLibraryActions['models']>().mockResolvedValue(options),
    save: vi.fn<AgentLibraryActions['save']>().mockImplementation(async (agents, revision) => library({ revision: revision + 1, agents: structuredClone(agents) })),
  };
}
const props = (overrides: Partial<TeamSettingsPageProps> = {}): TeamSettingsPageProps => ({ library: library(), canRead: true, canManage: true, modelOptions: options, actions: mockActions(), t: translate(), ...overrides });
const field = (name: string) => screen.getByLabelText(name, { exact: true }) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const change = (name: string, value: string) => fireEvent.change(field(name), { target: { value } });
const enabled = (number = 1) => screen.getByRole('switch', { name: `Agent ${number} · Enabled for conversation use` }) as HTMLInputElement;
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('configuration library, not a conversation execution form', () => {
  it('works without any session id and has no objective, task graph, concurrency or run controls', () => {
    const actions = mockActions(empty());
    render(<TeamSettingsPage {...props({ library: empty(), actions })} />);
    expect(screen.getByRole('region', { name: 'Agent library' })).toBeTruthy();
    expect(button('Add Architect').disabled).toBe(false);
    for (const name of ['Team name', 'Goal', 'Maximum concurrency', 'Task 1 · Description']) expect(screen.queryByLabelText(name)).toBeNull();
    for (const name of ['Start', 'Stop team', 'Add task', 'Save plan']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText('The conversation owns the objective, task assignments and execution approval. This page never starts agents.')).toBeTruthy();
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
  });

  it('renders bilingual dictionaries with matching placeholders and escapes all configured text', () => {
    expect(Object.keys(settingsZh).sort()).toEqual(Object.keys(settingsEn).sort());
    for (const key of Object.keys(settingsEn) as Array<keyof typeof settingsEn>) {
      expect((settingsZh[key].match(/\{\w+\}/g) ?? []).sort()).toEqual((settingsEn[key].match(/\{\w+\}/g) ?? []).sort());
    }
    const html = renderToStaticMarkup(<TeamSettingsPage {...props({ t: translate('zh'), library: library({ agents: [agent({ role: '<script>bad()</script>' })] }) })} />);
    expect(html).toContain('Agent 配置库');
    expect(html).toContain('一次配置');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
    expect(css).toContain('.dsh-team-settings, .dsh-team-settings::before');
    expect(css).not.toMatch(/(?:^|})\s*(?:body|html|:root|input|button)\b/);
  });

  it('adds editable templates with unique names, saves only configuration, and does not fetch or execute models', async () => {
    const actions = mockActions(empty());
    render(<TeamSettingsPage {...props({ library: empty(), actions })} />);
    fireEvent.click(button('Add Architect')); fireEvent.click(button('Add Architect')); fireEvent.click(button('Add Frontend engineer'));
    expect(field('Agent 1 · Name').value).toBe('architect');
    expect(field('Agent 2 · Name').value).toBe('architect-2');
    expect(field('Agent 3 · Name').value).toBe('frontend');
    expect(field('Agent 1 · Instructions (optional)').value).toContain('interfaces');
    change('Agent 1 · Role', 'System architect');
    fireEvent.click(enabled(2));
    change('Agent 3 · Model', JSON.stringify(['subscription', 'same-id']));
    expect(actions.save).not.toHaveBeenCalled();
    fireEvent.click(button('Save agents'));
    await screen.findByText('Saved library revision 1. Use these agents from a conversation.');
    const [saved, revision] = actions.save.mock.calls[0]!;
    expect(revision).toBe(0);
    expect(saved.map(value => value.name)).toEqual(['architect', 'architect-2', 'frontend']);
    expect(saved[0]!.role).toBe('System architect');
    expect(saved[1]!.enabled).toBe(false);
    expect(saved[2]!.model).toEqual({ provider: 'subscription', model: 'same-id' });
    for (const definition of saved) expect(Object.keys(definition).sort()).toEqual(definition.model
      ? ['enabled', 'instructions', 'model', 'name', 'role'] : ['enabled', 'instructions', 'name', 'role']);
    expect(actions.models).not.toHaveBeenCalled(); expect(actions.read).not.toHaveBeenCalled();
    expect(button('Save agents').disabled).toBe(true);
  });

  it('edits custom instructions and saves inheritance by omitting the model field', async () => {
    const actions = mockActions();
    render(<TeamSettingsPage {...props({ library: library({ agents: [agent({ model: { provider: 'deepseek', model: 'same-id' } })] }), actions })} />);
    change('Agent 1 · Name', 'reviewer'); change('Agent 1 · Role', 'Reviewer');
    change('Agent 1 · Instructions (optional)', 'Read the assigned files only.'); change('Agent 1 · Model', '');
    fireEvent.click(button('Save agents')); await waitFor(() => expect(actions.save).toHaveBeenCalledOnce());
    expect(actions.save.mock.calls[0]?.[0]).toEqual([{ name: 'reviewer', role: 'Reviewer', instructions: 'Read the assigned files only.', enabled: true }]);
    expect(actions.save.mock.calls[0]?.[1]).toBe(7);
  });

  it('removes definitions only from the editable library and allows explicitly saving an empty library', async () => {
    const original = library(); const before = structuredClone(original); const actions = mockActions(original);
    render(<TeamSettingsPage {...props({ library: original, actions })} />);
    fireEvent.click(button('Remove agent 1'));
    expect(original).toEqual(before); expect(actions.save).not.toHaveBeenCalled();
    fireEvent.click(button('Save agents')); await waitFor(() => expect(actions.save).toHaveBeenCalledWith([], 7, expect.any(AbortSignal)));
  });

  it('does not remove agents from the library when toggling enabled', async () => {
    const actions = mockActions(); render(<TeamSettingsPage {...props({ actions })} />);
    fireEvent.click(enabled()); expect(enabled().checked).toBe(false);
    expect(field('Agent 1 · Name').value).toBe('architect');
    fireEvent.click(button('Save agents')); await waitFor(() => expect(actions.save).toHaveBeenCalledOnce());
    expect(actions.save.mock.calls[0]?.[0][0]?.enabled).toBe(false);
    expect(actions.save.mock.calls[0]?.[0]).toHaveLength(1);
  });
});

describe('validation, availability and access boundaries', () => {
  it.each(['', 'captain', 'UpperCase', 'has spaces', 'double--dash'])('rejects invalid library name %s', value => {
    const actions = mockActions(); render(<TeamSettingsPage {...props({ actions })} />);
    change('Agent 1 · Name', value); fireEvent.click(button('Save agents'));
    expect(field('Agent 1 · Name').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('lower-kebab-case');
    expect(actions.save).not.toHaveBeenCalled();
  });

  it('rejects empty roles and duplicate names, including disabled definitions', () => {
    const actions = mockActions(); render(<TeamSettingsPage {...props({ actions })} />);
    fireEvent.click(button('Add custom agent')); change('Agent 2 · Name', 'architect');
    fireEvent.click(enabled(2)); fireEvent.click(button('Save agents'));
    expect(screen.getByRole('alert').textContent).toContain('Agent names must be unique');
    expect(screen.getByRole('alert').textContent).toContain('Enter a role');
    expect(actions.save).not.toHaveBeenCalled();
  });

  it('enforces the global library limit instead of the per-team limit', () => {
    render(<TeamSettingsPage {...props({ library: library({ agents: Array.from({ length: MAX_LIBRARY_AGENTS }, (_, index) => agent({ name: `reader-${index}` })) }) })} />);
    expect(button('Add custom agent').disabled).toBe(true); expect(button('Add Architect').disabled).toBe(true);
    expect(screen.getAllByRole('switch')).toHaveLength(MAX_LIBRARY_AGENTS);
  });

  it('hides all saved data and editors without read access', () => {
    const actions = mockActions(); render(<TeamSettingsPage {...props({ canRead: false, actions, library: library({ agents: [agent({ role: 'PRIVATE ROLE' })] }) })} />);
    expect(screen.queryByText('PRIVATE ROLE')).toBeNull(); expect(screen.queryByLabelText('Agent 1 · Name')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save agents' })).toBeNull();
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
  });

  it('disables changes for read-only access while leaving explicit model refresh available', () => {
    const refresh = vi.fn(); render(<TeamSettingsPage {...props({ canManage: false, onRefreshModels: refresh })} />);
    expect((field('Agent 1 · Name') as HTMLInputElement).readOnly).toBe(true);
    expect(enabled().matches(':disabled')).toBe(true); expect(button('Add Architect').matches(':disabled')).toBe(true);
    expect(button('Save agents').disabled).toBe(true); fireEvent.click(button('Refresh models')); expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not treat a failed or pending library read as a new empty library', () => {
    const view = render(<TeamSettingsPage {...props({ library: undefined, loading: true })} />);
    expect(button('Add Architect').disabled).toBe(true);
    view.rerender(<TeamSettingsPage {...props({ library: undefined, unavailableReason: 'Read failed' })} />);
    expect(screen.getByRole('alert').textContent).toBe('Read failed'); expect(button('Add Architect').disabled).toBe(true);
    expect(button('Reload library').disabled).toBe(false);
  });

  it('preserves a removed model and allows disabling that definition rather than silently falling back', async () => {
    const actions = mockActions(); render(<TeamSettingsPage {...props({ library: library({ agents: [agent({ model: { provider: 'removed', model: 'old' } })] }), actions })} />);
    expect(field('Agent 1 · Model').value).toBe(JSON.stringify(['removed', 'old']));
    change('Agent 1 · Role', 'Updated role'); expect(button('Save agents').disabled).toBe(true);
    fireEvent.click(enabled()); expect(button('Save agents').disabled).toBe(false);
    fireEvent.click(button('Save agents')); await waitFor(() => expect(actions.save).toHaveBeenCalledOnce());
    expect(actions.save.mock.calls[0]?.[0][0]).toMatchObject({ enabled: false, model: { provider: 'removed', model: 'old' } });
  });

  it('blocks an enabled explicit model while catalog loading fails, without clearing edits or selections', () => {
    const selected = library({ agents: [agent({ model: { provider: 'deepseek', model: 'same-id' } })] });
    const refresh = vi.fn(); const base = props({ library: selected, onRefreshModels: refresh });
    const view = render(<TeamSettingsPage {...base} />);
    change('Agent 1 · Role', 'My unsaved role');
    view.rerender(<TeamSettingsPage {...base} modelsLoading />); expect(button('Save agents').disabled).toBe(true);
    view.rerender(<TeamSettingsPage {...base} modelsError="Catalog unavailable" />);
    expect(field('Agent 1 · Role').value).toBe('My unsaved role'); expect(field('Agent 1 · Model').value).toBe(JSON.stringify(['deepseek', 'same-id']));
    expect(button('Save agents').disabled).toBe(true); fireEvent.click(button('Refresh models')); expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('library revisions, conflicts and request lifecycle', () => {
  it('preserves dirty input on a newer library snapshot and explicitly reloads the latest revision', async () => {
    const actions = mockActions(); const base = props({ actions }); const view = render(<TeamSettingsPage {...base} />);
    change('Agent 1 · Role', 'My draft');
    const incoming = library({ revision: 8, agents: [agent({ role: 'Other window' })] }); actions.read.mockResolvedValue(incoming);
    view.rerender(<TeamSettingsPage {...base} library={incoming} />);
    expect(field('Agent 1 · Role').value).toBe('My draft'); expect(button('Save agents').disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('Your edits are preserved');
    fireEvent.click(button('Discard edits & reload')); await screen.findByText('Loaded the current agent library.');
    expect(field('Agent 1 · Role').value).toBe('Other window'); expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps unsaved data after a server CAS rejection', async () => {
    const actions = mockActions(); actions.save.mockRejectedValue(new Error('Agent library changed. Reload before saving.'));
    render(<TeamSettingsPage {...props({ actions })} />); change('Agent 1 · Role', 'Keep my work'); fireEvent.click(button('Save agents'));
    await screen.findByText('Action failed: Agent library changed. Reload before saving.');
    expect(field('Agent 1 · Role').value).toBe('Keep my work'); expect(button('Discard edits & reload')).toBeTruthy();
  });

  it('adopts clean incoming snapshots but ignores older snapshots after save', async () => {
    const actions = mockActions(); const base = props({ actions }); const view = render(<TeamSettingsPage {...base} />);
    view.rerender(<TeamSettingsPage {...base} library={library({ revision: 8, agents: [agent({ role: 'New role' })] })} />);
    expect(field('Agent 1 · Role').value).toBe('New role');
    change('Agent 1 · Role', 'Saved role'); fireEvent.click(button('Save agents'));
    await screen.findByText('Saved library revision 9. Use these agents from a conversation.');
    view.rerender(<TeamSettingsPage {...base} library={library({ revision: 8 })} />);
    expect(field('Agent 1 · Role').value).toBe('Saved role');
  });

  it('does not let a late save overwrite a newer snapshot or the local draft', async () => {
    const pending = deferred<AgentLibrary>(); const actions = mockActions(); actions.save.mockReturnValue(pending.promise);
    const base = props({ actions }); const view = render(<TeamSettingsPage {...base} />);
    change('Agent 1 · Role', 'Local request'); fireEvent.click(button('Save agents'));
    view.rerender(<TeamSettingsPage {...base} library={library({ revision: 9 })} />);
    await act(async () => pending.resolve(library({ revision: 8 })));
    expect(field('Agent 1 · Role').value).toBe('Local request'); expect(button('Save agents').disabled).toBe(true);
  });

  it('serializes saves, exposes busy state and preserves drafts on failures', async () => {
    const pending = deferred<AgentLibrary>(); const actions = mockActions(); actions.save.mockReturnValue(pending.promise);
    render(<TeamSettingsPage {...props({ actions })} />); change('Agent 1 · Role', 'Pending draft');
    fireEvent.click(button('Save agents')); fireEvent.click(button('Save agents')); expect(actions.save).toHaveBeenCalledOnce();
    expect(screen.getByRole('region', { name: 'Agent library' }).getAttribute('aria-busy')).toBe('true');
    await act(async () => pending.reject(new Error('Storage unavailable')));
    expect(field('Agent 1 · Role').value).toBe('Pending draft'); expect(button('Save agents').disabled).toBe(false);
  });

  it('retains edits when explicit discard-and-reload fails', async () => {
    const actions = mockActions(); actions.read.mockRejectedValue(new Error('Read unavailable'));
    render(<TeamSettingsPage {...props({ actions })} />); change('Agent 1 · Role', 'Keep draft'); fireEvent.click(button('Discard edits & reload'));
    await screen.findByText('Action failed: Read unavailable'); expect(field('Agent 1 · Role').value).toBe('Keep draft');
  });

  it('rejects a non-advancing save response without discarding changes', async () => {
    const actions = mockActions(); actions.save.mockResolvedValue(library());
    render(<TeamSettingsPage {...props({ actions })} />); change('Agent 1 · Role', 'Unsaved'); fireEvent.click(button('Save agents'));
    await screen.findByText('Action failed: The save response is not a newer library revision. Your edits are preserved.');
    expect(field('Agent 1 · Role').value).toBe('Unsaved');
  });

  it('aborts pending requests on unmount and ignores late failures', async () => {
    const pending = deferred<AgentLibrary>(); const actions = mockActions(); actions.save.mockReturnValue(pending.promise);
    const view = render(<TeamSettingsPage {...props({ actions })} />); change('Agent 1 · Role', 'Pending'); fireEvent.click(button('Save agents'));
    const signal = actions.save.mock.calls[0]![2]!; view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => pending.reject(new Error('Late rejection'))); expect(screen.queryByText(/Late rejection/)).toBeNull();
  });

  it('clears cached private drafts and aborts saving when read permission is revoked', async () => {
    const pending = deferred<AgentLibrary>(); const actions = mockActions(); actions.save.mockReturnValue(pending.promise);
    const base = props({ actions }); const view = render(<TeamSettingsPage {...base} />);
    change('Agent 1 · Role', 'PRIVATE DRAFT'); fireEvent.click(button('Save agents'));
    const signal = actions.save.mock.calls[0]![2]!; view.rerender(<TeamSettingsPage {...base} canRead={false} />);
    expect(signal.aborted).toBe(true); expect(screen.queryByDisplayValue('PRIVATE DRAFT')).toBeNull();
    await act(async () => pending.resolve(library({ revision: 8, agents: [agent({ role: 'PRIVATE RESULT' })] })));
    expect(screen.queryByDisplayValue('PRIVATE RESULT')).toBeNull();
  });
});
