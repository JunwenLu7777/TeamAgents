import { describe, expect, it } from 'vitest';
import { MemberSchema, memberInput } from '../src/model.js';
import {
  AgentDefinitionSchema, AgentDefinitionsSchema, AgentLibraryRevisionSchema, AgentLibrarySchema,
  AgentLibrarySelectionSchema, MAX_LIBRARY_AGENTS,
} from '../src/library-model.js';

const agent = () => ({ name: 'researcher', role: 'Research', enabled: true });
describe('reusable Agent definition and library boundary', () => {
  it('accepts inherited or explicit models without session or execution state', () => {
    expect(AgentDefinitionSchema.parse(agent())).toEqual(agent());
    const configured = { ...agent(), model: { provider: 'configured', model: 'selected' }, instructions: 'Read carefully' };
    expect(AgentLibrarySchema.parse({ revision: 2, agents: [configured], updatedAt: 'now' })).toEqual({ revision: 2, agents: [configured], updatedAt: 'now' });
  });
  it.each(['a', 'agent1', 'agent-2', 'code-reviewer', 'a'.repeat(40), `${'a'.repeat(38)}-b`])
    ('accepts strict lower-kebab-case library name %s', name => {
      expect(AgentDefinitionSchema.parse({ ...agent(), name }).name).toBe(name);
    });
  it.each(['', 'captain', 'Agent', '2agent', '-agent', 'double--dash', 'trailing-', 'under_score', ' agent', 'a'.repeat(41)])
    ('rejects invalid or reserved library name %s', name => {
      expect(AgentDefinitionSchema.safeParse({ ...agent(), name }).success).toBe(false);
    });
  it.each(['double--dash', 'trailing-'])('does not tighten legacy member/history name %s', name => {
    expect(memberInput.parse({ name, role: 'Legacy' }).name).toBe(name);
    expect(MemberSchema.parse({ name, role: 'Legacy', sessionId: 'old-session' })).toEqual({ name, role: 'Legacy', sessionId: 'old-session' });
    expect(AgentDefinitionSchema.safeParse({ ...agent(), name, enabled: false }).success).toBe(false);
  });
  it.each(['goal', 'tasks', 'sessionId', 'ownerSessionId', 'workspaceId', 'status', 'revision'])('rejects Agent-level %s', field => {
    expect(AgentDefinitionSchema.safeParse({ ...agent(), [field]: 'injected' }).success).toBe(false);
  });
  it.each(['goal', 'tasks', 'sessionId', 'ownerSessionId', 'workspaceId', 'status'])('rejects library-level %s', field => {
    expect(AgentLibrarySchema.safeParse({ revision: 0, agents: [], updatedAt: null, [field]: 'injected' }).success).toBe(false);
  });
  it.each([undefined, 'true', 1, null])('requires an explicit boolean enabled flag %#', enabled => {
    expect(AgentDefinitionSchema.safeParse({ ...agent(), enabled }).success).toBe(false);
  });
  it('rejects duplicate names including disabled entries and caps the library at 100', () => {
    expect(MAX_LIBRARY_AGENTS).toBe(100);
    expect(() => AgentDefinitionsSchema.parse([agent(), { ...agent(), enabled: false }])).toThrow('Duplicate Agent name');
    const all = Array.from({ length: MAX_LIBRARY_AGENTS }, (_, index) => ({ ...agent(), name: `agent-${index}` }));
    expect(AgentDefinitionsSchema.parse(all)).toHaveLength(100);
    expect(AgentDefinitionsSchema.safeParse([...all, { ...agent(), name: 'extra' }]).success).toBe(false);
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null])('rejects unsafe revision %#', revision => {
    expect(AgentLibraryRevisionSchema.safeParse(revision).success).toBe(false);
  });
  it('accepts safe revision bounds and rejects empty/duplicate/oversized selections', () => {
    expect(AgentLibraryRevisionSchema.parse(0)).toBe(0);
    expect(AgentLibraryRevisionSchema.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => AgentLibrarySelectionSchema.parse([])).toThrow();
    expect(() => AgentLibrarySelectionSchema.parse(['researcher', 'researcher'])).toThrow('unique');
    expect(() => AgentLibrarySelectionSchema.parse(Array.from({ length: 13 }, (_, i) => `agent-${i}`))).toThrow();
    expect(() => AgentLibrarySelectionSchema.parse(['captain'])).toThrow();
  });
});
