import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { Context } from '@deepseek-ai/cordis';
import { registerTeamSettings } from '../../src/settings-integration.js';
import type { TeamModelOption } from '../../src/model.js';
import { AgentLibrarySchema, type AgentDefinition } from '../../src/library-model.js';
import { AgentLibraryRemoteRequests, TEAM_LIBRARY_REMOTE_ENDPOINTS } from '../../src/library-remote-contract.js';
import { settingsEn, settingsZh, type SettingsTranslate } from '../../src/settings-locales.js';
import { createRoleMember, roleTemplateZh } from '../../src/role-templates.js';
import type { AgentLibraryActions } from '../../src/settings-contract.js';

type Scenario = {
  id: string; width: number; height: number; theme: 'light' | 'dark';
  mode: 'populated' | 'empty'; fontScale: 1 | 2; longText: boolean;
};
type Check = { name: string; pass: boolean; actual: unknown };
type SaveRequest = { agents: AgentDefinition[]; expectedRevision: number };
const scenario = JSON.parse(decodeURIComponent(location.hash.slice(1))) as Scenario;
const counters = { read: 0, models: 0, saveAttempts: 0, save: 0, mounts: 0, forbiddenCalls: [] as string[], externalEffects: [] as string[] };
const accessEndpoints = new Set<string>();
const saveRequests: SaveRequest[] = [];
const interactionChecks: Check[] = [];
const record = (name: string, pass: boolean, actual: unknown): Check => ({ name, pass, actual });
const t: SettingsTranslate = (key, params = {}) => {
  const text = settingsZh[key] ?? settingsEn[key];
  return text.replace(/\{([^}]+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
};
const longToken = 'LayoutFixtureLongIdentifierWithoutBreaks'.repeat(12);
const longInstructions = Array.from({ length: 64 }, (_, index) => `本地配置要求 ${index + 1}：仅检查隔离夹具，不执行模型。${index % 8 === 0 ? longToken : '说明范围、依据、交付与验收。'}`).join('\n');
const options: TeamModelOption[] = [
  { provider: 'fixture-alpha', providerLabel: '本地示例 · 通用提供方', model: 'general-preview', modelLabel: '通用模型 · 仅目录示例' },
  { provider: 'fixture-beta', providerLabel: '本地示例 · 推理提供方', model: 'reasoning-preview', modelLabel: '推理模型 · 仅目录示例' },
  { provider: 'fixture-long', providerLabel: `本地长标签提供方-${longToken}`, model: 'long-label-preview', modelLabel: `超长模型名称-${longToken}` },
];
const seed = AgentLibrarySchema.parse({
  revision: scenario.mode === 'empty' ? 0 : 7,
  updatedAt: scenario.mode === 'empty' ? null : '2026-01-01T00:00:00.000Z',
  agents: scenario.mode === 'empty' ? [] : ['architect', 'frontend', 'tester'].map((id, index) => ({
    ...createRoleMember(id, [], key => roleTemplateZh[key]), enabled: index !== 2,
    ...(scenario.longText ? { instructions: longInstructions } : {}),
    ...(index === 0 ? {} : { model: { provider: options[index - 1]!.provider, model: options[index - 1]!.model } }),
  })),
});
const originalSeed = JSON.stringify(seed);
const originalOptions = JSON.stringify(options);
let storedLibrary = structuredClone(seed);

// No real Remote is mounted. Only an in-memory, revision-checked configuration
// save is allowed; network, browser persistence, and execution services fail closed.
function forbiddenEffect(name: string): never {
  counters.externalEffects.push(name);
  throw new Error(`The isolated library fixture forbids ${name}`);
}
function forbiddenCall(name: string): never {
  counters.forbiddenCalls.push(name);
  throw new Error(`No team, session, or model execution is available: ${name}`);
}
Object.defineProperty(window, 'fetch', { value: () => forbiddenEffect('fetch') });
for (const name of ['WebSocket', 'XMLHttpRequest', 'EventSource'] as const) {
  Object.defineProperty(window, name, { value: class { constructor() { forbiddenEffect(name); } } });
}
for (const name of ['getItem', 'setItem', 'removeItem', 'clear'] as const) {
  Object.defineProperty(Storage.prototype, name, { value: () => forbiddenEffect(`Storage.${name}`) });
}
const localActions: AgentLibraryActions = {
  read: async signal => { signal?.throwIfAborted(); counters.read += 1; return structuredClone(storedLibrary); },
  models: async signal => { signal?.throwIfAborted(); counters.models += 1; return structuredClone(options); },
  save: async (agents, expectedRevision, signal) => {
    signal?.throwIfAborted(); counters.saveAttempts += 1;
    const request = AgentLibraryRemoteRequests.save.parse({ agents, expectedRevision });
    if (request.expectedRevision !== storedLibrary.revision) throw new Error('Fake library revision conflict');
    saveRequests.push(structuredClone(request));
    storedLibrary = AgentLibrarySchema.parse({ agents: structuredClone(request.agents), revision: storedLibrary.revision + 1, updatedAt: '2026-01-02T00:00:00.000Z' });
    counters.save += 1;
    return structuredClone(storedLibrary);
  },
};
const actions = new Proxy(localActions, {
  get(target, key, receiver) {
    if (typeof key === 'string' && !['read', 'models', 'save'].includes(key)) return forbiddenCall(`actions.${key}`);
    return Reflect.get(target, key, receiver);
  },
});

// Capture actual root-scoped registrations without a sessionId, host profile,
// or selected conversation. Legacy session hooks below are throwing sentinels,
// not real providers, so a regression to session-scoped rendering fails closed.
const registered = new Map<string, ComponentType<any>>();
const specifications = new Map<string, { children?: Record<string, { scope?: string }> }>();
const context = {
  effect: (setup: () => unknown) => setup(),
  locale: { register: () => () => {}, bind: () => t },
  slots: {
    entries: () => [{ options: { order: 10 } }],
    inject: (_name: string, setup: () => unknown) => setup(),
    register: (spec: { name: string; children?: Record<string, { scope?: string }> }, component: ComponentType<any>) => {
      registered.set(spec.name, component); specifications.set(spec.name, spec); return () => {};
    },
  },
} as unknown as Context;
registerTeamSettings(context, actions);
const Section = registered.get('settings.section')!;
const Body = registered.get('team-agents.settings.body')!;
if (!Section || !Body) throw new Error('The real settings Section/Body registration was not captured');
const allowedEndpoints = Object.values(TEAM_LIBRARY_REMOTE_ENDPOINTS) as string[];
function useFakeRemoteAccess(endpoint: string) {
  accessEndpoints.add(endpoint);
  if (!allowedEndpoints.includes(endpoint)) return forbiddenCall(`useRemoteAccess(${endpoint})`);
  return true;
}
const forbiddenSessionProps = {
  SessionProvider: () => forbiddenCall('SessionProvider'),
  useAccess: () => forbiddenCall('useAccess'),
  useProjection: () => forbiddenCall('useProjection'),
};
document.body.dataset.theme = scenario.theme;
document.body.dataset.fontScale = String(scenario.fontScale);
const reactRoot = createRoot(document.getElementById('host-slot')!);
function renderLibrary() {
  counters.mounts += 1;
  flushSync(() => reactRoot.render(<Section key={counters.mounts} t={t} {...forbiddenSessionProps}
    renderSlot={() => <Body useRemoteAccess={useFakeRemoteAccess} t={t} {...forbiddenSessionProps} />}
  />));
}
renderLibrary();

const settle = async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); };
function root(): HTMLElement {
  const value = document.querySelector<HTMLElement>('.dsh-team-settings');
  if (!value) throw new Error('The real Agent library page did not render');
  return value;
}
function host(): HTMLElement { return document.getElementById('host-options')!; }
function rect(element: Element) {
  const { x, y, width, height, top, bottom, left, right } = element.getBoundingClientRect();
  return { x, y, width, height, top, bottom, left, right };
}
function selector(element: Element): string {
  if (element.id) return `#${element.id}`;
  const parent = element.parentElement;
  const siblings = parent ? [...parent.children].filter(item => item.tagName === element.tagName) : [];
  return `${parent && parent !== root() ? `${selector(parent)} > ` : '.dsh-team-settings > '}${element.tagName.toLowerCase()}${[...element.classList].map(name => `.${name}`).join('')}:nth-of-type(${siblings.indexOf(element) + 1})`;
}
function inside(element: Element, container: Element): boolean {
  const child = rect(element), box = rect(container);
  return child.height > 0 && child.top >= box.top - 1 && child.bottom <= box.bottom + 1;
}
function lastAgent(): HTMLElement {
  const cards = root().querySelectorAll<HTMLElement>('.dts-agent');
  const card = cards[cards.length - 1];
  if (!card) throw new Error('No Agent card was rendered');
  return card;
}
function setText(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  // Use the native setter so React's value tracker sees a real input change.
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
function readCard(card: HTMLElement) {
  const details = card.querySelector('details')!;
  return {
    name: card.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!.value,
    role: details.querySelector<HTMLInputElement>('input')!.value,
    instructions: details.querySelector<HTMLTextAreaElement>('textarea')!.value,
    model: card.querySelector<HTMLSelectElement>('select')!.value,
    enabled: card.querySelector<HTMLInputElement>('[role="switch"]')!.checked,
  };
}

async function prepare() {
  await document.fonts.ready; await settle();
  const before = root().querySelectorAll('.dts-agent').length;
  interactionChecks.push(record('root-scoped settings render without any selected session', registered.size === 2 && specifications.get('settings.section')?.children?.['team-agents.settings.body']?.scope === 'root' && counters.read === 1, { registrations: [...registered.keys()], selectedSession: null, read: counters.read, scope: specifications.get('settings.section')?.children?.['team-agents.settings.body']?.scope }));
  interactionChecks.push(record('initial global library including revision zero is readable', before === seed.agents.length && root().textContent!.includes(t('library.revision', { revision: seed.revision })), { expectedAgents: seed.agents.length, actualAgents: before, revision: seed.revision }));
  for (let index = 0; index < 2; index += 1) {
    root().querySelectorAll<HTMLButtonElement>('.dts-template')[1]!.click(); await settle();
  }
  const expectedName = scenario.mode === 'empty' ? 'frontend-2' : 'frontend-3';
  interactionChecks.push(record('role templates add two unique unsaved Agents with no session', root().querySelectorAll('.dts-agent').length === before + 2 && readCard(lastAgent()).name === expectedName && counters.save === 0, { before, after: root().querySelectorAll('.dts-agent').length, name: readCard(lastAgent()).name, saves: counters.save }));
  const details = lastAgent().querySelector<HTMLDetailsElement>('details')!;
  if (!details.open) details.querySelector<HTMLElement>('summary')!.click();
  await settle();
  const edited = {
    name: 'frontend-reviewer', role: '前端体验评审',
    instructions: scenario.longText ? longInstructions : '只处理会话中明确分配的前端评审工作，限定写入范围，提供依据和验收结果。',
    model: { provider: options[scenario.longText ? 2 : 1]!.provider, model: options[scenario.longText ? 2 : 1]!.model },
    enabled: false,
  };
  setText(lastAgent().querySelector<HTMLInputElement>('input:not([type="checkbox"])')!, edited.name); await settle();
  setText(lastAgent().querySelector<HTMLInputElement>('details input')!, edited.role); await settle();
  setText(lastAgent().querySelector<HTMLTextAreaElement>('textarea')!, edited.instructions); await settle();
  const select = lastAgent().querySelector<HTMLSelectElement>('select')!;
  select.value = JSON.stringify([edited.model.provider, edited.model.model]);
  select.dispatchEvent(new Event('change', { bubbles: true })); await settle();
  lastAgent().querySelector<HTMLInputElement>('[role="switch"]')!.click(); await settle();
  const editedUi = readCard(lastAgent());
  const expectedUi = { ...edited, model: JSON.stringify([edited.model.provider, edited.model.model]) };
  interactionChecks.push(record('name, role, instructions, independent model, and enabled switch are editable', JSON.stringify(editedUi) === JSON.stringify(expectedUi), { name: editedUi.name, role: editedUi.role, instructionLength: editedUi.instructions.length, model: editedUi.model, enabled: editedUi.enabled }));
  interactionChecks.push(record('edits stay local until the pure configuration save', counters.saveAttempts === 0 && JSON.stringify(storedLibrary) === originalSeed, { saveAttempts: counters.saveAttempts, revision: storedLibrary.revision }));
  const saveButton = root().querySelector<HTMLButtonElement>('button[type="submit"]')!;
  interactionChecks.push(record('configuration save is enabled without a session or execution approval', !saveButton.disabled && root().querySelectorAll('input[type="checkbox"]:not([role="switch"])').length === 0, { disabled: saveButton.disabled }));
  saveButton.click(); await settle();
  const saved = storedLibrary.agents[storedLibrary.agents.length - 1];
  interactionChecks.push(record('one local CAS save commits only the edited configuration', counters.save === 1 && counters.saveAttempts === 1 && storedLibrary.revision === seed.revision + 1 && JSON.stringify(saved) === JSON.stringify(edited), { saves: counters.save, attempts: counters.saveAttempts, previousRevision: seed.revision, revision: storedLibrary.revision, savedAgent: saved ? { ...saved, instructions: `[${saved.instructions?.length ?? 0} characters]` } : null }));
  const payload = saveRequests[0];
  const agentKeys = ['name', 'role', 'instructions', 'model', 'enabled'];
  interactionChecks.push(record('save payload has strict Agent fields and no run state, goal, task, or session', !!payload && payload.expectedRevision === seed.revision && Object.keys(payload).sort().join() === 'agents,expectedRevision' && payload.agents.every(agent => typeof agent.enabled === 'boolean' && Object.keys(agent).every(key => agentKeys.includes(key)) && (!agent.model || Object.keys(agent.model).sort().join() === 'model,provider')), payload ? { keys: Object.keys(payload), expectedRevision: payload.expectedRevision, agentKeys: payload.agents.map(agent => Object.keys(agent)), modelKeys: payload.agents.map(agent => agent.model ? Object.keys(agent.model) : []) } : null));
  renderLibrary(); await settle();
  const reread = readCard(lastAgent());
  interactionChecks.push(record('a fresh no-session mount reads the saved reusable library', counters.read === 2 && root().querySelectorAll('.dts-agent').length === before + 2 && JSON.stringify(reread) === JSON.stringify(expectedUi) && root().textContent!.includes(t('library.revision', { revision: seed.revision + 1 })), { mounts: counters.mounts, reads: counters.read, agents: root().querySelectorAll('.dts-agent').length, name: reread.name, enabled: reread.enabled, model: reread.model }));
  if (scenario.longText || scenario.fontScale === 2) {
    for (const panel of root().querySelectorAll<HTMLDetailsElement>('details')) {
      if (!panel.open) panel.querySelector<HTMLElement>('summary')!.click();
    }
    await settle();
  }
  host().scrollTop = 0; await settle();
  const area = rect(host());
  return { wheelPoint: { x: Math.round(area.left + area.width / 2), y: Math.round(area.top + 30) } };
}

async function checkLayout() {
  await settle();
  const page = root(), optionsHost = host(), title = page.querySelector('h2')!;
  const pageStyle = getComputedStyle(page), hostStyle = getComputedStyle(optionsHost);
  const wheelScrollTop = optionsHost.scrollTop;
  optionsHost.scrollTop = 0; await settle();
  const titleAtTop = rect(title), hostAtTop = rect(optionsHost);
  const widths = [document.documentElement, document.body, document.getElementById('host-panel')!, document.getElementById('host-content')!, optionsHost, page].map(element => ({
    selector: element === page ? '.dsh-team-settings' : element.id ? `#${element.id}` : element.tagName.toLowerCase(),
    clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, rect: rect(element),
  }));
  const nestedScrollers = [...page.querySelectorAll<HTMLElement>('*')].filter(element => {
    const style = getComputedStyle(element);
    return element.tagName !== 'TEXTAREA' && ['auto', 'scroll'].includes(style.overflowY)
      && element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 1;
  }).map(element => ({ selector: selector(element), clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  const overflowingElements = [...page.querySelectorAll<HTMLElement>('*')].filter(element => {
    if (!element.getClientRects().length || element.classList.contains('dts-sr-only')) return false;
    const box = rect(element), bounds = rect(page);
    return box.width > 0 && (box.right > bounds.right + 1 || box.left < bounds.left - 1);
  }).slice(0, 20).map(element => ({ selector: selector(element), rect: rect(element), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  const visibleControls = [...page.querySelectorAll<HTMLElement>('button, summary, input, select, textarea')].filter(element => element.getClientRects().length > 0);
  const lastControl = visibleControls[visibleControls.length - 1];
  optionsHost.scrollTop = optionsHost.scrollHeight; await settle();
  const bottom = { scrollTop: optionsHost.scrollTop, scrollHeight: optionsHost.scrollHeight, clientHeight: optionsHost.clientHeight, page: rect(page) };
  const lastControlAtBottom = lastControl ? { selector: selector(lastControl), rect: rect(lastControl), visible: inside(lastControl, optionsHost) } : null;
  // The conversation-usage explanation follows Save; it need not pin the button.
  const terminalElements = [...page.querySelectorAll<HTMLElement>('p, button, summary')].filter(element => element.getClientRects().length > 0);
  const terminal = terminalElements[terminalElements.length - 1]!;
  const terminalAtBottom = { selector: selector(terminal), rect: rect(terminal), visible: inside(terminal, optionsHost) };
  if (lastControl) { optionsHost.scrollTop += rect(lastControl).top - rect(optionsHost).top - 24; await settle(); }
  const lastControlReachable = lastControl ? { selector: selector(lastControl), rect: rect(lastControl), visible: inside(lastControl, optionsHost), hostScrollTop: optionsHost.scrollTop } : null;
  const panel = rect(document.getElementById('host-panel')!);
  const nav = rect(document.getElementById('host-nav')!);
  const desktopGeometry = scenario.width === 1280;
  const forbiddenControls = [...page.querySelectorAll<HTMLElement>('button, input, textarea, select')].filter(element => {
    const accessibleName = element.getAttribute('aria-label') ?? (element.tagName === 'BUTTON' ? element.textContent ?? '' : '');
    return /\b(goal|tasks?|start|stop|approv\w*|concurrency)\b|目标|任务|启动|停止|执行确认|最大并发/i.test(accessibleName);
  }).map(element => ({ selector: selector(element), label: element.getAttribute('aria-label') ?? element.textContent }));
  const checks = [
    ...interactionChecks,
    record('host geometry matches the constrained desktop or narrow fixture', desktopGeometry ? panel.width === 800 && panel.height === 684 && panel.left === 240 && panel.top === 68 && nav.width === 176 : nav.width === 0 && panel.width === scenario.width - 32, { panel, nav }),
    record('root-scoped slot renders without a session wrapper box', getComputedStyle(document.getElementById('host-slot')!).display === 'contents' && page.parentElement?.id === 'host-slot', { slotDisplay: getComputedStyle(document.getElementById('host-slot')!).display, pageParent: page.parentElement?.id }),
    record('fixture has no global border-box reset', getComputedStyle(document.body).boxSizing === 'content-box', getComputedStyle(document.body).boxSizing),
    record('plugin root owns border-box sizing', pageStyle.boxSizing === 'border-box', pageStyle.boxSizing),
    record('document, host, and plugin have no horizontal overflow', widths.every(value => value.scrollWidth <= value.clientWidth + 1), widths),
    record('visible descendant boxes stay within plugin width', overflowingElements.length === 0, overflowingElements),
    record('first title is visible at the top of the host scroller', titleAtTop.top >= hostAtTop.top - 1 && titleAtTop.bottom <= hostAtTop.bottom + 1, { titleAtTop, hostAtTop }),
    record('host options column owns vertical scrolling', ['auto', 'scroll'].includes(hostStyle.overflowY) && optionsHost.scrollHeight > optionsHost.clientHeight + 1, { overflowY: hostStyle.overflowY, ...bottom }),
    record('real wheel input scrolls the host', wheelScrollTop > 0, { wheelScrollTop }),
    record('plugin is not an extra page-level scroll container', !['auto', 'scroll'].includes(pageStyle.overflowY) && page.scrollTop === 0 && nestedScrollers.length === 0, { rootOverflowY: pageStyle.overflowY, rootScrollTop: page.scrollTop, nestedScrollers, allowedLocalScrollControls: ['textarea'] }),
    record('host scroll reaches the end of the plugin', Math.abs(bottom.scrollHeight - bottom.clientHeight - bottom.scrollTop) <= 1, bottom),
    record('terminal content is visible at the host scroll end', terminalAtBottom.visible, terminalAtBottom),
    record('last control remains fully reachable through the same host scroller', !lastControl || lastControlReachable!.visible, lastControlReachable),
    record('settings contains no goal, task, start, stop, or approval controls', forbiddenControls.length === 0 && !page.querySelector('.dts-runs, input[type="checkbox"]:not([role="switch"])'), forbiddenControls),
    record('only global library read, models, and save permissions are requested', [...accessEndpoints].every(endpoint => allowedEndpoints.includes(endpoint)) && accessEndpoints.size === 3, [...accessEndpoints]),
    record('no team, session, or model execution service was touched', counters.forbiddenCalls.length === 0, counters.forbiddenCalls),
    record('legacy SessionProvider, useAccess, and useProjection sentinels were never invoked', !counters.forbiddenCalls.some(name => ['SessionProvider', 'useAccess', 'useProjection'].includes(name)), counters.forbiddenCalls),
    record('no network or browser-storage effects were attempted', counters.externalEffects.length === 0, counters.externalEffects),
    record('immutable seed and fake model directory were not mutated', JSON.stringify(seed) === originalSeed && JSON.stringify(options) === originalOptions, null),
    record('each no-session mount reads only the local library and model directory once', counters.mounts === 2 && counters.read === 2 && counters.models === 2 && counters.save === 1, counters),
    record('long instructions remain editable in expanded local textareas', !scenario.longText || [...page.querySelectorAll<HTMLTextAreaElement>('.dts-agent details[open] textarea')].some(element => element.value === longInstructions), { expandedInstructions: page.querySelectorAll('.dts-agent details[open] textarea').length, longInstructionLength: longInstructions.length }),
    record('requested text scale is active', parseFloat(pageStyle.fontSize) === 14 * scenario.fontScale, { fontSize: pageStyle.fontSize, fontScale: scenario.fontScale }),
  ];
  optionsHost.scrollTop = 0; await settle();
  return { scenario, selectedSession: null, pass: checks.every(check => check.pass), checks, counters, saveRequestShapes: saveRequests.map(request => ({ expectedRevision: request.expectedRevision, agents: request.agents.length })), widths, overflowingElements, lastControlAtBottom, terminalAtBottom, lastControlReachable };
}

async function verifyOverflowNegativeControl() {
  const page = root(), optionsHost = host();
  const originalStyle = page.getAttribute('style');
  const measure = () => ({ hostClientWidth: optionsHost.clientWidth, hostScrollWidth: optionsHost.scrollWidth, rootWidth: rect(page).width, boxSizing: getComputedStyle(page).boxSizing });
  const baseline = measure();
  let broken;
  try {
    page.style.boxSizing = 'content-box'; page.style.padding = '28px';
    await settle(); broken = measure();
  } finally {
    if (originalStyle === null) page.removeAttribute('style'); else page.setAttribute('style', originalStyle);
    optionsHost.scrollTop = 0; await settle();
  }
  const restored = measure();
  return [
    record('negative control detects content-box plus padding horizontal overflow', broken!.hostScrollWidth > broken!.hostClientWidth + 1, { baseline, broken }),
    record('negative control restores the original non-overflowing layout', restored.boxSizing === 'border-box' && restored.hostScrollWidth <= restored.hostClientWidth + 1 && restored.rootWidth === baseline.rootWidth, restored),
  ];
}

async function showAgents() {
  const library = root().querySelector<HTMLDetailsElement>('.dts-library');
  if (library?.open) library.querySelector<HTMLElement>('summary')?.click();
  await settle();
  const first = root().querySelector<HTMLElement>('.dts-agent');
  if (first) host().scrollTop += rect(first).top - rect(host()).top - 12;
  await settle();
}
Object.assign(window, { layoutFixture: { prepare, checkLayout, showAgents, verifyOverflowNegativeControl } });
