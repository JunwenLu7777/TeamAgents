// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { SlotCore, resolveSlotLabel, type PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots';
import { registerTeamConversationView, TEAM_CONVERSATION_VIEW_ID } from '../src/conversation-view.js';
import { en, type TeamTranslate } from '../src/locales.js';
import type { Team } from '../src/model.js';
import type { TeamSettingsActions } from '../src/settings-contract.js';

const t: TeamTranslate = (key, params = {}) => en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
const team = (): Team => ({ id: 'team', ownerSessionId: 'session', workspaceId: 'workspace', name: 'Review crew', goal: 'Review, do not execute.',
  maxConcurrency: 3, revision: 5, status: 'draft', createdAt: 'now', updatedAt: 'now',
  members: [{ name: 'reviewer', role: 'Review' }], tasks: [{ id: 'review', subject: 'Review sources', description: 'Read only',
    assignee: 'reviewer', dependencies: [], writeScopes: [], status: 'pending', attempt: 0 }], messages: [] });
afterEach(cleanup);
function setup() {
  const core = new SlotCore();
  function Root({ renderSlot }: PropsRenderSlots<'conversation.view' | 'conversation.composer.dock'>) {
    return <>{renderSlot('conversation.view', { inspectCall: undefined, viewRequest: null, openView: () => {}, completeViewRequest: () => {} })}{renderSlot('conversation.composer.dock', {})}</>;
  }
  core.register({ name: 'root', children: {
    'conversation.view': { kind: 'list', scope: 'session' },
    'conversation.composer.dock': { kind: 'list', scope: 'session' },
  } }, Root);
  for (const [id, label, order] of [['chat', 'Chat', 10], ['trajectory', 'Trajectory', 20], ['context', 'Context', 30], ['native-team', 'Formation', 5000]] as const) {
    core.register({ name: 'conversation.view', id, label, order }, () => null);
  }
  const actions = { read: vi.fn<TeamSettingsActions['read']>(), models: vi.fn<TeamSettingsActions['models']>(),
    save: vi.fn<TeamSettingsActions['save']>(), start: vi.fn<TeamSettingsActions['start']>(),
    stop: vi.fn<TeamSettingsActions['stop']>(), retry: vi.fn<TeamSettingsActions['retry']>(),
    exportRun: vi.fn<TeamSettingsActions['exportRun']>() };
  const forSession = vi.fn(() => actions);
  const cleanups: Array<() => void> = [];
  let Component!: ComponentType<any>;
  const register = (...args: Parameters<SlotCore['register']>) => { Component = args[1] as ComponentType<any>; return core.register(...args); };
  const ctx = { slots: { entries: (name: string) => core.entries(name), register,
    inject: (_name: string, install: () => () => void) => { const off = install(); cleanups.push(off); return off; } } } as unknown as Context;
  registerTeamConversationView(ctx, { forSession });
  return { core, Component, actions, forSession, dispose: () => cleanups.forEach(off => off()) };
}

describe('native top conversation tab', () => {
  it('appends after the existing formation tab without occupying or modifying composer slots', () => {
    const h = setup(); const entries = h.core.entries('conversation.view');
    expect(entries.map(entry => entry.options.id)).toEqual(['chat', 'trajectory', 'context', 'native-team', TEAM_CONVERSATION_VIEW_ID]);
    expect(resolveSlotLabel(entries.at(-1)!.options.label)).toBe('TeamAgents');
    expect(entries.at(-1)!.options.order).toBe(5001);
    expect(h.core.entries('conversation.composer.dock')).toHaveLength(0);
    expect(h.forSession).not.toHaveBeenCalled();
    h.dispose();
    expect(h.core.entries('conversation.view').map(entry => entry.options.id)).toEqual(['chat', 'trajectory', 'context', 'native-team']);
  });

  it('renders an expanded page with visible goal and no outer disclosure, automatic read or execution', () => {
    const h = setup(); const View = h.Component;
    render(<View sessionId="session" useProjection={() => team()} useAccess={() => true} t={t} />);
    expect(document.querySelector('section.dsh-team-agents.dta-page')).toBeTruthy();
    expect(document.querySelector('details.dsh-team-agents')).toBeNull();
    expect((document.querySelector('.dta-goal') as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByRole('heading', { name: 'Review crew' })).toBeTruthy();
    expect(screen.getByText('Review, do not execute.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop team' })).toBeNull();
    for (const action of Object.values(h.actions)) expect(action).not.toHaveBeenCalled();
  });

  it.each([null, undefined])('shows a useful empty/unavailable state for %s without creating a team', snapshot => {
    const h = setup(); const View = h.Component;
    render(<View sessionId="session" useProjection={() => snapshot} useAccess={() => true} t={t} />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'TeamAgents' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    for (const action of Object.values(h.actions)) expect(action).not.toHaveBeenCalled();
  });

  it('does not expose a different conversation snapshot when switching tabs or sessions', () => {
    const h = setup(); const View = h.Component;
    render(<View sessionId="other-session" useProjection={() => team()} useAccess={() => true} t={t} />);
    expect(screen.queryByText('Review crew')).toBeNull();
    expect(screen.getByText('The team snapshot does not belong to this conversation and is not displayed.')).toBeTruthy();
    for (const action of Object.values(h.actions)) expect(action).not.toHaveBeenCalled();
  });
});
