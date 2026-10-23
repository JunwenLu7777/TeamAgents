import type { Context } from '@deepseek-ai/cordis';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { apply, inject } from '../src/client.js';
import { TeamDashboard } from '../src/dashboard.js';
import { en, locales, zh, type TeamTranslate } from '../src/locales.js';
import type { Task, Team } from '../src/model.js';

// Dock glue stays independently testable; separate suites exercise real settings and Gateway wiring.
vi.mock('../src/remote-client.js', () => ({ mountTeamRemote: vi.fn(async () => ({ forSession: vi.fn() })) }));
vi.mock('../src/settings-integration.js', () => ({ registerTeamSettings: vi.fn() }));

function translator(language: 'en' | 'zh' = 'en'): TeamTranslate {
  return (key, params = {}) => locales[language][key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'design', subject: 'Design the interface', description: 'Document the layout.',
    assignee: 'designer', dependencies: [], writeScopes: ['src/ui'],
    status: 'pending', attempt: 0, ...overrides,
  };
}

function team(overrides: Partial<Team> = {}): Team {
  return {
    id: 'team-1', ownerSessionId: 'captain-session', workspaceId: 'workspace-1',
    name: 'Release crew', goal: 'Ship a clear, usable release.', maxConcurrency: 3,
    revision: 7, status: 'running', createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T01:00:00.000Z',
    members: [{ name: 'designer', role: 'Interface design' }, { name: 'tester', role: 'Verification' }],
    tasks: [
      task({ id: 'plan', status: 'completed', output: 'Plan agreed.', writeScopes: [] }),
      task({ status: 'running', attempt: 1, dependencies: ['plan'] }),
      task({ id: 'verify', subject: 'Verify the release', assignee: 'tester', dependencies: ['design'], writeScopes: ['tests'] }),
      task({ id: 'preview', subject: 'Preview the release', assignee: 'tester', status: 'failed', error: 'Preview failed.', attempt: 1, writeScopes: [] }),
    ],
    messages: [], ...overrides,
  };
}

function render(value: Team | null | undefined, language: 'en' | 'zh' = 'en') {
  return renderToStaticMarkup(<TeamDashboard team={value} t={translator(language)} />);
}

describe('TeamDashboard', () => {
  it.each([null, undefined])('does not occupy the composer without a projection (%s)', value => {
    expect(render(value)).toBe('');
  });

  it('shows snapshot progress, member activity, dependency IDs, and advisory scopes', () => {
    const html = render(team());
    expect(html).toContain('Release crew');
    expect(html).toContain('Revision 7');
    expect(html).toContain('1/4 done');
    expect(html).toContain('value="1" max="4"');
    expect(html).toContain('aria-label="1 of 4 tasks completed"');
    expect(html).toContain('1 running');
    expect(html).toContain('1 pending');
    expect(html).toContain('1 failed');
    expect(html).toMatch(/data-status="active">Active/);
    expect(html).toMatch(/data-status="idle">Idle/);
    expect(html).toContain('Working on design');
    expect(html).toContain('<code class="dta-tag">plan</code>');
    expect(html).toContain('Waiting for: design');
    expect(html).toContain('Write scopes · advisory');
    expect(html).toContain('<code class="dta-tag">src/ui</code>');
    expect(html).toContain('not filesystem permissions');
  });

  it('starts collapsed, uses native disclosures for results, and exposes no execution controls', () => {
    const html = render(team());
    const disclosures = html.match(/<details\b[^>]*>/g) ?? [];
    expect(disclosures.length).toBeGreaterThan(3);
    expect(disclosures.every(tag => !/\bopen(?:\s|=|>)/.test(tag))).toBe(true);
    expect(html).toMatch(/<details class="dta-result"><summary>Output<\/summary><pre[^>]*>Plan agreed\.<\/pre>/);
    expect(html).toMatch(/<details class="dta-result"><summary>Error<\/summary><pre[^>]*>Preview failed\.<\/pre>/);
    expect(html).toContain('Manage this team in chat.');
    expect(html).not.toMatch(/<(?:button|input|form|script|iframe)\b/);
  });

  it('handles an empty draft with determinate zero progress', () => {
    const html = render(team({ status: 'draft', tasks: [], members: [] }));
    expect(html).toContain('Draft');
    expect(html).toContain('0/0 done');
    expect(html).toContain('value="0" max="1"');
    expect(html).toContain('No members yet.');
    expect(html).toContain('No tasks yet. Plan the work in chat.');
    expect(html).toContain('No team messages yet.');
    expect(html).not.toContain('NaN');
  });

  it.each(['draft', 'running', 'paused', 'blocked', 'completed'] as const)('translates the %s team status', status => {
    expect(render(team({ status }))).toContain(`data-status="${status}">${en[`status.${status}`]}`);
    expect(render(team({ status }), 'zh')).toContain(`data-status="${status}">${zh[`status.${status}`]}`);
  });

  it('uses bilingual copy with matching dictionary keys and interpolation parameters', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect((zh[key].match(/\{\w+\}/g) ?? []).sort()).toEqual((en[key].match(/\{\w+\}/g) ?? []).sort());
    }
    const html = render(team(), 'zh');
    expect(html).toContain('版本 7');
    expect(html).toContain('已完成 1/4');
    expect(html).toContain('工作中');
    expect(html).toContain('空闲');
    expect(html).toContain('等待前置任务：design');
    expect(html).toContain('写入范围 · 约定');
    expect(html).toContain('在对话中管理团队。');
    expect(html).not.toContain('Manage this team');
  });

  it('escapes all projected text, including failed errors and completed outputs', () => {
    const unsafe = '<script>alert("team")</script><img src=x onerror=alert(1)>';
    const html = render(team({
      name: unsafe, goal: unsafe,
      members: [{ name: 'designer', role: unsafe }],
      tasks: [task({ subject: unsafe, description: unsafe, status: 'failed', error: unsafe }), task({ id: 'done', status: 'completed', output: unsafe })],
      messages: [{ id: 'message', from: unsafe, to: 'designer', text: unsafe, createdAt: '2026-10-23T01:00:00.000Z' }],
    }));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(&quot;team&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('shows at most six recent messages, newest first, without mutating the snapshot', () => {
    const snapshot = team({ messages: Array.from({ length: 8 }, (_, index) => ({
      id: `message-${index}`, from: 'captain', to: 'designer', text: `Message text ${index}`,
      createdAt: '2026-10-23T01:00:00.000Z', deliveredAt: index === 7 ? '2026-10-23T01:01:00.000Z' : undefined,
    })) });
    const before = structuredClone(snapshot);
    const html = render(snapshot);
    expect(html).toContain('Latest 6 of 8');
    expect(html).not.toContain('Message text 0');
    expect(html).not.toContain('Message text 1');
    expect(html.indexOf('Message text 7')).toBeLessThan(html.indexOf('Message text 6'));
    expect(html).toContain('Delivered');
    expect(html).toContain('Queued');
    expect(html).toContain('dateTime="2026-10-23T01:00:00.000Z"');
    expect(snapshot).toEqual(before);
  });

  it('shows explicit empty results when the host recorded no error or output text', () => {
    const html = render(team({ tasks: [task({ status: 'failed' }), task({ id: 'done', status: 'completed', output: '' })] }));
    expect(html).toContain('No error details recorded.');
    expect(html).toContain('No output recorded.');
  });
});

describe('pending explanations', () => {
  const running = task({ id: 'active', status: 'running', assignee: 'tester', writeScopes: ['src'] });

  it('prioritizes unfinished and missing dependencies over other blockers', () => {
    const html = render(team({ maxConcurrency: 1, tasks: [running, task({ dependencies: ['active', 'missing'] })] }));
    expect(html).toContain('Waiting for: active, missing');
    expect(html).not.toContain('Overlapping write scope</dd>');
  });

  it('waits for a member before considering scope or capacity conflicts', () => {
    const html = render(team({ maxConcurrency: 1, tasks: [running, task({ assignee: 'tester' })] }));
    expect(html).toContain('Member is busy');
    expect(html).not.toContain('Concurrency limit reached</dd>');
  });

  it.each([
    ['src', 'src/ui'], ['src/ui', 'src'], ['src', 'src'], ['.', 'docs'], ['docs', '.'],
  ])('explains overlapping scope %s and %s', (left, right) => {
    expect(render(team({ tasks: [{ ...running, writeScopes: [left] }, task({ writeScopes: [right] })] }))).toContain('Overlapping write scope');
  });

  it('treats sibling path prefixes as distinct scopes', () => {
    const html = render(team({ tasks: [{ ...running, writeScopes: ['src/ui'] }, task({ writeScopes: ['src/ui-kit'] })] }));
    expect(html).toContain('Ready; waiting for the scheduler');
    expect(html).not.toContain('Overlapping write scope</dd>');
  });

  it('explains the concurrency limit for otherwise independent tasks', () => {
    expect(render(team({ maxConcurrency: 1, tasks: [running, task({ writeScopes: ['docs'] })] }))).toContain('Concurrency limit reached');
  });

  it.each(['draft', 'paused', 'blocked', 'completed'] as const)('does not describe a %s team as ready to run', status => {
    expect(render(team({ status, tasks: [task()] }))).toContain('Team is not running');
  });

  it('does not block on completed dependencies or empty scope declarations', () => {
    const html = render(team({ tasks: [running, task({ id: 'done', status: 'completed' }), task({ dependencies: ['done'], writeScopes: [] })] }));
    expect(html).toContain('Ready; waiting for the scheduler');
    expect(html).toContain('No scopes declared');
  });
});

describe('current DSH client integration', () => {
  it('waits for the dock declaration and uses its projection and locale seats', async () => {
    const disposeLocale = vi.fn();
    const disposeSlot = vi.fn();
    const effects: Array<() => void> = [];
    let install: (() => () => void) | undefined;
    const register = vi.fn((_options: unknown, _component: unknown) => disposeSlot);
    const registerLocale = vi.fn(() => disposeLocale);
    const context = {
      effect(setup: () => () => void) { effects.push(setup()); },
      locale: { register: registerLocale },
      slots: {
        inject: vi.fn((_key: string, callback: () => () => void) => { install = callback; return () => {}; }),
        register,
      },
    };
    await apply(context as unknown as Context);
    expect(inject).toEqual(expect.arrayContaining(['slots', 'locale', 'uiSession']));
    expect(registerLocale).toHaveBeenCalledWith('team-agents', locales);
    expect(context.slots.inject).toHaveBeenCalledWith('conversation.composer.dock', expect.any(Function));
    expect(register).not.toHaveBeenCalled();

    const dispose = install!();
    expect(register).toHaveBeenCalledWith({ name: 'conversation.composer.dock', id: 'dsh-team-agents', order: 40, locale: 'team-agents' }, expect.any(Function));
    const Slot = register.mock.calls[0]![1] as ComponentType<{ useProjection: (key: 'team-agents') => Team | null | undefined; t: TeamTranslate }>;
    const projection = vi.fn((_key: 'team-agents'): Team | null | undefined => team());
    expect(renderToStaticMarkup(<Slot useProjection={projection} t={translator()} />)).toContain('Release crew');
    expect(projection).toHaveBeenCalledWith('team-agents');
    projection.mockReturnValue(null);
    expect(renderToStaticMarkup(<Slot useProjection={projection} t={translator()} />)).toBe('');
    dispose();
    for (const cleanup of effects) cleanup();
    expect(disposeSlot).toHaveBeenCalledOnce();
    expect(disposeLocale).toHaveBeenCalledOnce();
  });

  it('bundles for the browser with only React runtime externals', async () => {
    const result = await build({
      entryPoints: ['src/client.tsx'], bundle: true, write: false, metafile: true,
      platform: 'browser', format: 'cjs', external: ['react', 'react/jsx-runtime'], jsx: 'automatic',
    });
    const imports = Object.values(result.metafile!.outputs).flatMap(output => output.imports);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every(entry => entry.external && ['react', 'react/jsx-runtime'].includes(entry.path))).toBe(true);
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs).toContain('src/model.ts');
    expect(inputs).toContain('src/settings-integration.tsx');
    expect(inputs).not.toContain('src/projection.ts');
    expect(inputs).not.toContain('src/remote.ts');
    expect(inputs).not.toContain('src/model-route.ts');
    expect(result.outputFiles[0]!.text).toContain('module.exports');
  });
});
