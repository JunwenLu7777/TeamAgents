import { z } from 'zod';
import { memberInput, memberName } from './model.js';

export const MAX_LIBRARY_AGENTS = 100;
export const AgentLibraryRevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const AgentDefinitionSchema = memberInput.extend({
  // New library entries match the settings editor; legacy team/member names remain unchanged.
  name: memberName.refine(name => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name), 'Agent names must use lower-kebab-case'),
  enabled: z.boolean(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
export const AgentDefinitionsSchema = z.array(AgentDefinitionSchema).max(MAX_LIBRARY_AGENTS).superRefine((agents, ctx) => {
  const names = new Set<string>();
  agents.forEach((agent, index) => {
    if (names.has(agent.name)) ctx.addIssue({ code: 'custom', path: [index, 'name'], message: 'Duplicate Agent name' });
    names.add(agent.name);
  });
});

/** Reusable configuration only: no workspace, session, goal, tasks, or execution state. */
export const AgentLibrarySchema = z.strictObject({
  revision: AgentLibraryRevisionSchema,
  agents: AgentDefinitionsSchema,
  updatedAt: z.string().nullable(),
});
export type AgentLibrary = z.infer<typeof AgentLibrarySchema>;

export const AgentLibrarySelectionSchema = z.array(memberName).min(1).max(12)
  .refine(names => new Set(names).size === names.length, 'Selected Agent names must be unique');
