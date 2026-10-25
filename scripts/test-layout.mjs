import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// No HTTP server, Playwright, model call, real Remote mount, or logged-in GUI is used.
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = join(workspace, 'lib', 'layout-check');
const conversationMode = process.argv.includes('--conversation');
if (process.argv.slice(2).some(argument => argument !== '--conversation')) throw new Error('Only --conversation is supported');
const reportPath = join(outputDirectory, conversationMode ? 'conversation-layout-report.json' : 'layout-report.json');
const chromePath = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const scenarios = conversationMode ? [
  { id: 'desktop-light-team-tab', width: 1280, height: 820, theme: 'light', mode: 'team' },
  { id: 'narrow-dark-team-tab', width: 390, height: 844, theme: 'dark', mode: 'team' },
  { id: 'desktop-empty-team-tab', width: 1280, height: 820, theme: 'light', mode: 'empty' },
] : [
  { id: 'desktop-light-library', width: 1280, height: 820, theme: 'light', mode: 'populated', fontScale: 1, longText: false },
  { id: 'narrow-dark-library', width: 390, height: 844, theme: 'dark', mode: 'populated', fontScale: 1, longText: false },
  { id: 'desktop-dark-long-instructions', width: 1280, height: 820, theme: 'dark', mode: 'populated', fontScale: 1, longText: true },
  { id: 'narrow-light-double-text-library', width: 390, height: 844, theme: 'light', mode: 'populated', fontScale: 2, longText: true },
  { id: 'desktop-light-double-text-library', width: 1280, height: 820, theme: 'light', mode: 'populated', fontScale: 2, longText: true },
  { id: 'narrow-light-empty-library-no-session', width: 390, height: 844, theme: 'light', mode: 'empty', fontScale: 1, longText: false },
];

class ChromePipe {
  constructor(child) {
    this.child = child;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.buffer = '';
    this.stderr = '';
    this.closed = false;
    this.exit = new Promise(resolveExit => child.once('close', (code, signal) => {
      this.closed = true;
      this.fail(new Error(`Chrome exited (${code ?? signal})`));
      resolveExit({ code, signal });
    }));
    child.once('error', error => { this.closed = true; this.fail(error); });
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-16_384); });
    child.stdio[3].on('error', error => this.fail(error));
    child.stdio[4].setEncoding('utf8');
    child.stdio[4].on('data', chunk => {
      this.buffer += chunk;
      for (let end; (end = this.buffer.indexOf('\0')) >= 0;) {
        const text = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!text) continue;
        let message;
        try { message = JSON.parse(text); }
        catch (error) { this.fail(new Error(`Invalid CDP pipe frame: ${error.message}`)); continue; }
        if (message.id !== undefined) {
          const item = this.pending.get(message.id);
          if (!item) continue;
          clearTimeout(item.timer); this.pending.delete(message.id);
          if (message.error) item.reject(new Error(`${item.method}: ${message.error.message}`));
          else item.resolve(message.result ?? {});
        } else {
          for (const listener of this.listeners) listener(message);
        }
      }
    });
  }
  fail(error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  request(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('The owned Chrome process is closed'));
    const id = ++this.nextId;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 20_000);
      timer.unref();
      this.pending.set(id, { resolve: resolveRequest, reject, timer, method });
      this.child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`, error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  nextEvent(method, sessionId) {
    let cancel;
    const promise = new Promise((resolveEvent, reject) => {
      const remove = this.onEvent(message => {
        if (message.method !== method || message.sessionId !== sessionId) return;
        clearTimeout(timer); remove(); resolveEvent(message.params);
      });
      const timer = setTimeout(() => { remove(); reject(new Error(`CDP event timed out: ${method}`)); }, 20_000);
      timer.unref();
      cancel = () => { clearTimeout(timer); remove(); };
    });
    // A navigation failure cancels this waiter instead of leaving an unhandled rejection.
    promise.catch(() => {});
    return { promise, cancel: () => cancel() };
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
}

async function screenshot(cdp, sessionId, filename, scenario) {
  const result = await cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, sessionId);
  const bytes = Buffer.from(result.data, 'base64');
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Chrome did not return a PNG screenshot');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width !== scenario.width || height !== scenario.height) throw new Error(`Unexpected PNG dimensions ${width}x${height}`);
  const path = join(outputDirectory, filename);
  await writeFile(path, bytes);
  return { path, width, height, sha256: createHash('sha256').update(bytes).digest('hex'), scenario: scenario.id };
}

async function runScenario(cdp, fixtureUrl, scenario) {
  const errors = [], externalRequests = [], screenshots = [];
  const { targetId } = await cdp.request('Target.createTarget', { url: 'about:blank' });
  let removeEvents = () => {};
  let load;
  try {
    const { sessionId } = await cdp.request('Target.attachToTarget', { targetId, flatten: true });
    removeEvents = cdp.onEvent(message => {
      if (message.sessionId !== sessionId) return;
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        errors.push(details.exception?.description ?? details.text);
      }
      if (message.method === 'Network.requestWillBeSent' && /^(https?|wss?):/i.test(message.params.request.url)) {
        externalRequests.push(message.params.request.url);
      }
    });
    await cdp.request('Page.enable', {}, sessionId);
    await cdp.request('Runtime.enable', {}, sessionId);
    await cdp.request('Network.enable', {}, sessionId);
    await cdp.request('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] }, sessionId);
    await cdp.request('Emulation.setDeviceMetricsOverride', { width: scenario.width, height: scenario.height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp.request('Emulation.setEmulatedMedia', { media: 'screen', features: [
      { name: 'prefers-color-scheme', value: scenario.theme }, { name: 'prefers-reduced-motion', value: 'reduce' },
    ] }, sessionId);
    load = cdp.nextEvent('Page.loadEventFired', sessionId);
    const navigation = await cdp.request('Page.navigate', { url: `${fixtureUrl}#${encodeURIComponent(JSON.stringify(scenario))}` }, sessionId);
    if (navigation.errorText) throw new Error(`Fixture navigation failed: ${navigation.errorText}`);
    await load.promise;
    const prepared = await evaluate(cdp, sessionId, 'window.layoutFixture.prepare()');
    const negativeChecks = scenario.id === 'desktop-light-library'
      ? await evaluate(cdp, sessionId, 'window.layoutFixture.verifyOverflowNegativeControl()') : [];
    await cdp.request('Input.dispatchMouseEvent', { type: 'mouseWheel', ...prepared.wheelPoint, deltaX: 0, deltaY: 500 }, sessionId);
    const result = await evaluate(cdp, sessionId, 'window.layoutFixture.checkLayout()');
    result.checks.push(...negativeChecks);
    result.checks.push({ name: 'browser reported no uncaught page errors', pass: errors.length === 0, actual: errors });
    result.checks.push({ name: 'fixture page made no external HTTP or WebSocket requests', pass: externalRequests.length === 0, actual: externalRequests });
    result.pass = result.checks.every(check => check.pass);
    if (result.pass && conversationMode) {
      const name = scenario.id === 'desktop-light-team-tab' ? 'team-conversation-tab.png'
        : scenario.id === 'narrow-dark-team-tab' ? 'team-conversation-tab-narrow.png' : 'team-conversation-tab-empty.png';
      screenshots.push(await screenshot(cdp, sessionId, name, scenario));
    } else if (result.pass && scenario.id === 'desktop-light-library') {
      screenshots.push(await screenshot(cdp, sessionId, 'team-settings-light.png', scenario));
      await evaluate(cdp, sessionId, 'window.layoutFixture.showAgents()');
      screenshots.push(await screenshot(cdp, sessionId, 'team-settings-models.png', scenario));
    } else if (result.pass && scenario.id === 'narrow-dark-library') {
      screenshots.push(await screenshot(cdp, sessionId, 'team-settings-narrow-dark.png', scenario));
    } else if (!result.pass) {
      screenshots.push(await screenshot(cdp, sessionId, `failure-${scenario.id}.png`, scenario));
    }
    return { ...result, screenshots };
  } catch (error) {
    return { scenario, pass: false, error: error.stack ?? String(error), pageErrors: errors, externalRequests, screenshots };
  } finally {
    load?.cancel(); removeEvents();
    await cdp.request('Target.closeTarget', { targetId }).catch(() => {});
  }
}

async function waitForExit(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout(null), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

async function closeOwnedChrome(cdp) {
  if (!cdp.closed) await cdp.request('Browser.close').catch(() => {});
  let outcome = await waitForExit(cdp.exit, 3_000);
  if (!outcome) { cdp.child.kill('SIGTERM'); outcome = await waitForExit(cdp.exit, 3_000); }
  if (!outcome) { cdp.child.kill('SIGKILL'); outcome = await waitForExit(cdp.exit, 3_000); }
  if (!outcome) throw new Error('Unable to confirm exit of the owned Chrome process');
  return outcome;
}

await mkdir(outputDirectory, { recursive: true });
const report = {
  schema: conversationMode ? 'TeamConversationTabLayoutCheck/v1' : 'AgentLibraryLayoutCheck/v2', createdAt: new Date().toISOString(),
  fixture: conversationMode
    ? 'Real SlotCore and TeamAgents conversation.view registration inside a simulated native tab/view/composer shell. Not the logged-in Desktop GUI.'
    : 'Isolated reusable Agent library using the real root-scoped registerTeamSettings Section/Body components and verified host sizing/scroll contract. No session is selected or supplied. Not a revalidation of the logged-in Desktop GUI.',
  isolation: conversationMode ? { transport: 'CDP pipe (no HTTP listener)', data: 'synthetic team projection', registration: 'real native SlotCore', allowedInteractions: ['native tab selection', 'scroll'], remoteCalls: 'throwing sentinels', temporaryProfile: true } : { transport: 'CDP pipe (no HTTP listener)', data: 'in-memory fake Agent library with compare-and-set saves and a fake model directory', selectedSession: null, rootAuthorization: 'fake public useRemoteAccess hook for library read/models/save only', allowedInteractions: ['role template', 'edit Agent name/role/instructions', 'independent model selection', 'enabled switch', 'in-memory configuration save', 'fresh no-session mount', 'expand/collapse details', 'scroll'], externalPageRequests: 'blocked by CSP and CDP', browserStorageAndNetworkApis: 'guarded', temporaryProfile: true },
  limitations: conversationMode ? ['Native header/composer geometry and tab selection are simulated around real SlotCore and the real plugin view.', 'The authenticated Desktop URL and live data are not accessed.', 'The fixture never starts, stops, or reads a real team; real authorization and executions are outside this layout claim.'] : ['Host chrome is a contract fixture, not the installed Desktop shell.', 'Only a fake in-memory configuration library is saved; real profile persistence and Remote authorization are not exercised.', 'No sessionId or selected conversation is supplied; legacy SessionProvider/useAccess/useProjection are throwing sentinels, not real providers.', 'Local textarea scrolling is allowed; extra page-level scrolling is not.', '200% root/body text size is tested, not OS display scaling.', 'No real team/session creation, model execution, credentials, deployment, or live model availability is exercised.'],
  chromePath, outputDirectory, scenarios: [], screenshots: [], pass: false,
};
let profile, cdp;
const profilePrefix = `dsh-teamagents-layout-${process.pid}-`;
try {
  if (!isAbsolute(chromePath)) throw new Error('CHROME_BIN must be an absolute path to an existing Chrome/Chromium executable');
  await access(chromePath, constants.X_OK).catch(() => { throw new Error(`Chrome is unavailable at ${chromePath}. Set CHROME_BIN to an installed executable; this check never silently skips or installs a browser.`); });
  const bundle = await build({
    absWorkingDir: workspace, entryPoints: [conversationMode ? 'tests/browser/conversation-fixture.tsx' : 'tests/browser/fixture.tsx'],
    bundle: true, write: false, platform: 'browser', target: 'es2022', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  const source = bundle.outputFiles[0].text;
  report.bundleSha256 = createHash('sha256').update(source).digest('hex');
  const css = await readFile(join(workspace, 'tests', 'browser', conversationMode ? 'conversation-host.css' : 'host.css'), 'utf8');
  const fixturePath = join(outputDirectory, conversationMode ? 'conversation-fixture.html' : 'fixture.html');
  const shell = conversationMode ? '<div id="conversation-fixture"></div>'
    : '<div id="host-panel"><nav id="host-nav" aria-label="模拟设置导航"><strong>设置</strong><span>通用</span><span>模型</span><span>插件市场</span><span class="active">TeamAgents</span></nav><div id="host-content"><header id="host-header">设置 · TeamAgents<small>无会话隔离夹具 · 仅内存配置保存 · 不执行模型</small></header><main id="host-options"><div id="host-slot"></div></main></div></div>';
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><title>TeamAgents isolated layout fixture</title><style>${css}</style></head><body>${shell}<script>${source.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  await writeFile(fixturePath, html);
  profile = await mkdtemp(join(await realpath(tmpdir()), profilePrefix));
  const child = spawn(chromePath, [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-smooth-scrolling',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--disable-extensions', '--disable-breakpad', '--disable-domain-reliability', '--metrics-recording-only',
    '--password-store=basic', '--use-mock-keychain', '--host-resolver-rules=MAP * ~NOTFOUND',
    '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  cdp = new ChromePipe(child);
  report.browser = await cdp.request('Browser.getVersion');
  for (const scenario of scenarios) {
    const result = await runScenario(cdp, pathToFileURL(fixturePath).href, scenario);
    report.scenarios.push(result); report.screenshots.push(...result.screenshots);
    const failed = result.checks?.filter(check => !check.pass).map(check => check.name) ?? [result.error];
    console.log(`${result.pass ? 'PASS' : 'FAIL'} ${scenario.id}${result.pass ? '' : `: ${failed.join('; ')}`}`);
  }
  report.pass = report.scenarios.length === scenarios.length && report.scenarios.every(result => result.pass);
} catch (error) {
  report.error = error.stack ?? String(error);
  console.error(error.message ?? error);
} finally {
  if (cdp) {
    try { report.browserExit = await closeOwnedChrome(cdp); }
    catch (error) { report.cleanupError = error.message; report.pass = false; }
    if (!report.pass) report.chromeDiagnostics = cdp.stderr;
  }
  if (profile) {
    try {
      // Verify exact ownership and resolved absolute target before the only deletion.
      const tempRoot = await realpath(tmpdir());
      const target = await realpath(profile);
      const info = await lstat(profile);
      if (target !== profile || dirname(target) !== tempRoot || !basename(target).startsWith(profilePrefix) || info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error('Refusing to delete a profile outside this run’s verified temporary directory');
      }
      if (cdp && !cdp.closed) throw new Error('Refusing to delete a profile while the owned browser may still be running');
      await rm(target, { recursive: true, force: false });
      report.profileRemoved = true;
    } catch (error) { report.profileCleanupError = error.message; report.pass = false; }
  }
  report.summary = {
    passedScenarios: report.scenarios.filter(result => result.pass).length,
    totalScenarios: scenarios.length,
    passedAssertions: report.scenarios.flatMap(result => result.checks ?? []).filter(check => check.pass).length,
    totalAssertions: report.scenarios.flatMap(result => result.checks ?? []).length,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${reportPath}`);
  for (const shot of report.screenshots) console.log(`Screenshot: ${shot.path}`);
  console.log(`${report.pass ? 'PASS' : 'FAIL'} ${report.summary.passedScenarios}/${scenarios.length} isolated host-contract scenarios; ${report.summary.passedAssertions}/${report.summary.totalAssertions} assertions`);
  process.exitCode = report.pass ? 0 : 1;
}
