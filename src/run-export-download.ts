import {
  TeamRunExportResultSchema,
  type TeamRunExportResult,
} from './run-export-contract.js';

/**
 * Browser-only download ownership for an already negotiated export envelope.
 *
 * The host returns text; this module is the only place that turns it into a
 * Blob/ObjectURL/anchor. It never writes a host file, opens a window, or
 * injects HTML. The returned cleanup is idempotent: revoking the URL twice is
 * harmless, and the scheduled revocation is cancelled once cleanup runs.
 */
export interface TeamRunExportDownloadEnvironment {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  /** Temporary anchor factory. Tests may substitute a non-navigating element. */
  createAnchor(): HTMLAnchorElement;
  /** Defaults to a macrotask so the browser has consumed the click navigation. */
  schedule(callback: () => void): unknown;
  cancelScheduled(handle: unknown): void;
  /** Appends/removes the temporary anchor; the native document by default. */
  mount(anchor: HTMLAnchorElement): void;
  unmount(anchor: HTMLAnchorElement): void;
}

function defaultEnvironment(): TeamRunExportDownloadEnvironment {
  const url = globalThis.URL;
  const doc = globalThis.document;
  if (typeof url?.createObjectURL !== 'function' || typeof url.revokeObjectURL !== 'function') {
    throw new Error('File downloads are unavailable in this browser.');
  }
  if (!doc?.body) throw new Error('File downloads are unavailable in this browser.');
  return {
    createObjectURL: blob => url.createObjectURL(blob),
    revokeObjectURL: value => url.revokeObjectURL(value),
    createAnchor: () => doc.createElement('a'),
    schedule: callback => globalThis.setTimeout(callback, 0),
    cancelScheduled: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    mount: anchor => doc.body.appendChild(anchor),
    unmount: anchor => anchor.remove(),
  };
}

/**
 * Validate the envelope, allocate exactly one object URL, click one temporary
 * anchor, and return an idempotent cleanup that revokes the URL. Validation
 * happens before any allocation, so a rejected result never leaks a URL or
 * downloads a partially formed file.
 */
export function downloadTeamRunExport(
  result: TeamRunExportResult,
  environment?: TeamRunExportDownloadEnvironment,
): () => void {
  // Strict parse rejects a wrong MIME/extension/byte length before any browser
  // resource (env, Blob, object URL, anchor) is created.
  const parsed = TeamRunExportResultSchema.parse(result);
  const env = environment ?? defaultEnvironment();
  const blob = new Blob([parsed.content], { type: parsed.mimeType });
  let url: string | undefined;
  let timer: unknown;
  let revoked = false;
  const revoke = () => {
    if (revoked || url === undefined) return;
    revoked = true;
    env.revokeObjectURL(url);
  };
  const cleanup = () => {
    if (timer !== undefined) {
      env.cancelScheduled(timer);
      timer = undefined;
    }
    revoke();
  };
  let anchor: HTMLAnchorElement | undefined;
  try {
    url = env.createObjectURL(blob);
    anchor = env.createAnchor();
    anchor.href = url;
    anchor.download = parsed.filename;
    anchor.rel = 'noopener';
    // Keep the temporary anchor connected for the click without exposing UI chrome.
    anchor.style.display = 'none';
    env.mount(anchor);
    anchor.click();
    // Scheduling can fail too; keep it inside the resource cleanup boundary.
    timer = env.schedule(revoke);
  } catch (failure) {
    if (anchor) {
      try { env.unmount(anchor); } catch { /* already detached */ }
    }
    cleanup();
    throw failure;
  }
  // The click is synchronous; revocation is deferred until the browser has
  // been given a chance to consume the navigation.
  try { env.unmount(anchor); } catch { /* already detached */ }
  return cleanup;
}