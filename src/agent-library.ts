import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Member } from './model.js';
import {
  AgentDefinitionsSchema, AgentLibraryRevisionSchema, AgentLibrarySchema, AgentLibrarySelectionSchema,
  type AgentDefinition, type AgentLibrary,
} from './library-model.js';

export const agentLibraryDomain = defineDomain({
  name: 'dsh_team_agent_library', version: 1,
  tables: { libraries: domainTable<string, AgentLibrary>(AgentLibrarySchema) },
});

export interface AgentLibraryTable {
  get(key: string): AgentLibrary | undefined;
  put(key: string, value: AgentLibrary): Promise<void>;
}
export class AgentLibraryError extends Error {
  constructor(readonly code: 'team-agent-library/revision-conflict' | 'team-agent-library/selection-invalid' | 'team-agent-library/unavailable', message: string) {
    super(message); this.name = 'AgentLibraryError';
  }
}

/** A host-wide reusable library in its own domain; never mutates the historical team table. */
export class AgentLibraryStore {
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  constructor(private readonly table: AgentLibraryTable) {}

  read(): AgentLibrary {
    return AgentLibrarySchema.parse(this.table.get('default') ?? { revision: 0, agents: [], updatedAt: null });
  }

  async save(agents: AgentDefinition[], expectedRevision: number, signal?: AbortSignal, guard?: () => void): Promise<AgentLibrary> {
    this.assertOpen();
    signal?.throwIfAborted();
    // Parse before entering the queue so later caller mutation cannot change an admitted edit.
    const values = AgentDefinitionsSchema.parse(agents);
    const revision = AgentLibraryRevisionSchema.parse(expectedRevision);
    const action = async () => {
      this.assertOpen(); signal?.throwIfAborted(); guard?.();
      const current = this.read();
      if (current.revision !== revision) {
        throw new AgentLibraryError('team-agent-library/revision-conflict', 'Agent library changed. Reload and review the current saved revision before saving.');
      }
      if (revision === Number.MAX_SAFE_INTEGER) throw new AgentLibraryError('team-agent-library/unavailable', 'Agent library revision limit reached.');
      const next = AgentLibrarySchema.parse({ revision: revision + 1, agents: values, updatedAt: new Date().toISOString() });
      // Last synchronous admission point before the SDK's non-cancellable durable write.
      this.assertOpen(); signal?.throwIfAborted(); guard?.();
      await this.table.put('default', next);
      return AgentLibrarySchema.parse(next);
    };
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }

  /** Capture enabled definitions in requested order; selection does not reserve, write, or run them. */
  select(names: string[], expectedRevision: number): Member[] {
    const selected = AgentLibrarySelectionSchema.parse(names);
    const revision = AgentLibraryRevisionSchema.parse(expectedRevision);
    const library = this.read();
    if (library.revision !== revision) {
      throw new AgentLibraryError('team-agent-library/revision-conflict', 'Agent library changed. List the configured Agents again and select the current revision.');
    }
    return selected.map(name => {
      const definition = library.agents.find(agent => agent.name === name);
      if (!definition || !definition.enabled) {
        throw new AgentLibraryError('team-agent-library/selection-invalid', 'A selected Agent is missing or disabled. Select enabled Agents from the current library.');
      }
      const { enabled: _enabled, ...member } = definition;
      return member;
    });
  }

  private assertOpen(): void {
    if (this.closing) throw new AgentLibraryError('team-agent-library/unavailable', 'Agent library is shutting down.');
  }

  async dispose(): Promise<void> {
    this.closing = true;
    await this.tail;
  }
}
