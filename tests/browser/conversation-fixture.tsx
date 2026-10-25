import { useState, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { Context } from '@deepseek-ai/cordis';
import { SlotCore, resolveSlotLabel, type PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots';
import { registerTeamConversationView, TEAM_CONVERSATION_VIEW_ID } from '../../src/conversation-view.js';
import { zh, type TeamTranslate } from '../../src/locales.js';
import { TeamSchema } from '../../src/model.js';
import type { TeamSettingsActions } from '../../src/settings-contract.js';

type Scenario = { id: string; width: number; height: number; theme: 'light' | 'dark'; mode: 'team' | 'empty' };
const scenario = JSON.parse(decodeURIComponent(location.hash.slice(1))) as Scenario;
const calls: string[] = [];
const record = (name: string, pass: boolean, actual: unknown) => ({ name, pass, actual });
const t: TeamTranslate = (key, params = {}) => zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
const snapshot = TeamSchema.parse({
  id: 'fixture-team', ownerSessionId: 'fixture-session', workspaceId: 'fixture-workspace', name: 'TeamAgents 配置库与会话协作验收',
  goal: '仅展示隔离夹具中的测试计划。目标来自会话；此次位置检查不会启动团队、调用模型或改动真实配置。',
  maxConcurrency: 3, revision: 5, status: 'draft', createdAt: 'now', updatedAt: 'now',
  members: [
    { name: 'backend', role: '后端工程师', model: { provider: '示例提供方', model: '示例模型' } },
    { name: 'frontend', role: '前端工程师', model: { provider: '示例提供方', model: '示例模型' } },
    { name: 'tester', role: '测试工程师', model: { provider: '示例提供方', model: '示例模型' } },
    { name: 'architect', role: '架构师' },
  ],
  tasks: Array.from({ length: 12 }, (_, index) => ({ id: `review-${index + 1}`, subject: `测试项目 ${index + 1} · 核对边界与验收结果`, description: '隔离的模拟任务。无需执行。',
    assignee: ['backend', 'frontend', 'tester', 'architect'][index % 4], dependencies: [], writeScopes: [], status: 'pending', attempt: 0 })), messages: [],
});
function forbidden(name: string): never { calls.push(name); throw new Error(`Unexpected effect: ${name}`); }
Object.defineProperty(window, 'fetch', { value: () => forbidden('fetch') });
for (const key of ['WebSocket', 'XMLHttpRequest', 'EventSource'] as const) Object.defineProperty(window, key, { value: class { constructor() { forbidden(key); } } });
for (const key of ['getItem', 'setItem', 'removeItem', 'clear'] as const) Object.defineProperty(Storage.prototype, key, { value: () => forbidden(`Storage.${key}`) });
const actions: TeamSettingsActions = {
  read: async () => forbidden('read'), models: async () => forbidden('models'), save: async () => forbidden('save'),
  start: async () => forbidden('start'), stop: async () => forbidden('stop'), retry: async () => forbidden('retry'),
};

const core = new SlotCore();
function Root({ renderSlot }: PropsRenderSlots<'conversation.view' | 'conversation.composer.dock'>) {
  return <>{renderSlot('conversation.view', { inspectCall: undefined, viewRequest: null, openView: () => {}, completeViewRequest: () => {} })}{renderSlot('conversation.composer.dock', {})}</>;
}
core.register({ name: 'root', children: { 'conversation.view': { kind: 'list', scope: 'session' }, 'conversation.composer.dock': { kind: 'list', scope: 'session' } } }, Root);
for (const [id, label, order] of [['chat', '对话', 10], ['trajectory', '轨迹', 20], ['context', '上下文', 30], ['native-team', '编队', 40]] as const) {
  core.register({ name: 'conversation.view', id, label, order }, () => null);
}
let View!: ComponentType<any>;
const injected: string[] = [];
const ctx = { slots: { entries: (name: string) => core.entries(name),
  register: (...args: Parameters<SlotCore['register']>) => { View = args[1] as ComponentType<any>; return core.register(...args); },
  inject: (name: string, install: () => () => void) => { injected.push(name); return install(); },
} } as unknown as Context;
registerTeamConversationView(ctx, { forSession: id => { if (id !== 'fixture-session') return forbidden('wrong-session'); return actions; } });
const tabs = core.entries('conversation.view').map(entry => ({ id: entry.options.id!, label: resolveSlotLabel(entry.options.label) ?? entry.options.id! }));
function App() {
  const [selected, select] = useState('chat');
  return <><aside id="fixture-sidebar"><strong>DeepSeek Harness</strong><small>隔离布局验证 · 非已登录界面</small></aside>
    <div id="fixture-conversation"><header id="fixture-header"><div id="fixture-title">当前项目测试会话 <small>原生 Slot 注册 · 无真实模型调用</small></div>
      <nav id="fixture-tabs" role="tablist" aria-label="会话视图">{tabs.map(tab => <button key={tab.id} type="button" role="tab" data-view={tab.id}
        aria-selected={selected === tab.id} onClick={() => select(tab.id)}>{tab.label}</button>)}</nav></header>
      <main id="fixture-scroll"><div data-slot="conversation.view">{selected === TEAM_CONVERSATION_VIEW_ID
        ? <View sessionId="fixture-session" useProjection={() => scenario.mode === 'empty' ? null : snapshot} useAccess={() => true} t={t}
          inspectCall={undefined} viewRequest={null} openView={() => forbidden('openView')} completeViewRequest={() => {}} />
        : <p className="fixture-placeholder">{tabs.find(tab => tab.id === selected)?.label} · 本地夹具占位</p>}</div></main>
      <footer id="fixture-composer"><textarea aria-label="聊天输入框" defaultValue="尚未发送的聊天草稿" /><small>输入框保持原位，TeamAgents 不再放在这里。</small><div id="fixture-dock" data-slot="conversation.composer.dock" /></footer>
    </div></>;
}
document.body.dataset.theme = scenario.theme;
flushSync(() => createRoot(document.getElementById('conversation-fixture')!).render(<App />));
const settle = async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); };
const rect = (node: Element) => { const { top, bottom, left, right, width, height } = node.getBoundingClientRect(); return { top, bottom, left, right, width, height }; };
const scroller = () => document.getElementById('fixture-scroll')!;
const checks: ReturnType<typeof record>[] = [];
let composerBefore: ReturnType<typeof rect>;
async function prepare() {
  await document.fonts.ready; await settle();
  composerBefore = rect(document.getElementById('fixture-composer')!);
  checks.push(record('team panel is not mounted on the ordinary chat view', document.querySelector('.dsh-team-view') === null, null));
  checks.push(record('only the native conversation.view seat is registered', injected.length === 1 && injected[0] === 'conversation.view', injected));
  checks.push(record('composer dock has no plugin entry', core.entries('conversation.composer.dock').length === 0, core.entries('conversation.composer.dock').length));
  document.querySelector<HTMLButtonElement>(`[data-view='${TEAM_CONVERSATION_VIEW_ID}']`)!.click(); await settle();
  checks.push(record('selecting the native tab mounts the team view', !!document.querySelector('.dsh-team-view'), null));
  document.querySelector<HTMLButtonElement>("[data-view='chat']")!.click(); await settle();
  checks.push(record('switching to chat unmounts the team view without a leftover dock', !document.querySelector('.dsh-team-view') && !document.getElementById('fixture-dock')!.children.length, null));
  document.querySelector<HTMLButtonElement>(`[data-view='${TEAM_CONVERSATION_VIEW_ID}']`)!.click(); await settle();
  const area = rect(scroller()); return { wheelPoint: { x: Math.round(area.left + area.width / 2), y: Math.round(area.top + 80) } };
}
async function checkLayout() {
  await settle();
  const main = scroller(), page = document.querySelector<HTMLElement>('.dsh-team-view')!;
  const mainStyle = getComputedStyle(main), wheelTop = main.scrollTop;
  const selected = document.querySelector<HTMLButtonElement>(`[data-view='${TEAM_CONVERSATION_VIEW_ID}']`)!;
  const formation = document.querySelector<HTMLButtonElement>("[data-view='native-team']")!;
  const tab = rect(selected), previousTab = rect(formation), composer = document.getElementById('fixture-composer')!, composerAfter = rect(composer);
  const widths = [document.documentElement, document.body, document.getElementById('fixture-conversation')!, main, page].map(node => ({ id: node.id || node.className || node.tagName, client: node.clientWidth, scroll: node.scrollWidth }));
  main.scrollTop = 0; await settle();
  const title = page.querySelector<HTMLElement>("[role='heading'], h2")!;
  const titleRect = rect(title), mainRect = rect(main);
  main.scrollTop = main.scrollHeight; await settle();
  const footerText = page.querySelector<HTMLElement>('.dta-footer') ?? page.querySelector<HTMLElement>('.dtv-hint')!;
  const tail = rect(footerText), end = main.scrollTop;
  const body = page.querySelector<HTMLElement>('.dta-body');
  checks.push(
    record('TeamAgents is the native tab immediately after Formation', tabs.at(-2)?.id === 'native-team' && tabs.at(-1)?.id === TEAM_CONVERSATION_VIEW_ID, tabs),
    record('tab occupies the top row to the right of Formation', tab.left >= previousTab.right && Math.abs(tab.top - previousTab.top) <= 1 && tab.top < 76, { tab, previousTab }),
    record('the native tab is selected', selected.getAttribute('aria-selected') === 'true', selected.getAttribute('aria-selected')),
    record('active content is under the view seat, never in the composer', page.closest('[data-slot]')?.getAttribute('data-slot') === 'conversation.view' && !composer.querySelector('.dsh-team-view, .dsh-team-agents'), null),
    record('composer geometry and unsent draft remain unchanged', JSON.stringify(composerBefore) === JSON.stringify(composerAfter) && document.querySelector<HTMLTextAreaElement>('#fixture-composer textarea')!.value === '尚未发送的聊天草稿', { composerBefore, composerAfter }),
    record('no horizontal page overflow', widths.every(width => width.scroll <= width.client + 1), widths),
    record('title is visible at the top of the conversation scrollport', titleRect.top >= mainRect.top - 1 && titleRect.bottom <= mainRect.bottom + 1, { titleRect, mainRect }),
    record('host owns vertical scrolling for a populated team', mainStyle.overflowY === 'auto' && (scenario.mode === 'empty' || (main.scrollHeight > main.clientHeight && wheelTop > 0)), { wheelTop, height: main.clientHeight, scrollHeight: main.scrollHeight }),
    record('team page is expanded and is not a nested bounded dock', scenario.mode === 'empty' || (page.querySelector('section.dta-page') !== null && getComputedStyle(body!).maxHeight === 'none' && getComputedStyle(body!).overflowY === 'visible'), null),
    record('end of team content is reachable above the composer', Math.abs(main.scrollHeight - main.clientHeight - end) <= 1 && tail.bottom <= mainRect.bottom + 1 && tail.top >= mainRect.top - 1, { end, tail, mainRect }),
    record('no execution, network, storage, or automatic remote reads occurred', calls.length === 0, calls),
    record('there is no Start control', ![...page.querySelectorAll('button')].some(button => /启动|Start/.test(button.textContent ?? '')), null),
  );
  main.scrollTop = 0; await settle();
  return { scenario, pass: checks.every(check => check.pass), checks };
}
Object.assign(window, { layoutFixture: { prepare, checkLayout } });
