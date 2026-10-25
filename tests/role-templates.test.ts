import { afterEach, describe, expect, it, vi } from 'vitest';
import { memberInput, memberName } from '../src/model.js';
import {
  ROLE_TEMPLATES, createRoleMember, roleTemplateEn, roleTemplateZh, type RoleTemplateTextKey,
} from '../src/role-templates.js';

const locales = [['en', roleTemplateEn], ['zh', roleTemplateZh]] as const;
const translateEn = (key: RoleTemplateTextKey): string => roleTemplateEn[key];
const translateZh = (key: RoleTemplateTextKey): string => roleTemplateZh[key];

afterEach(() => vi.unstubAllGlobals());

describe('built-in role templates', () => {
  it('provides exactly nine distinct stable template ids and legal member names', () => {
    expect(ROLE_TEMPLATES.map(template => template.id)).toEqual([
      'architect', 'frontend', 'backend', 'tester', 'ui-designer',
      'database', 'product-manager', 'devops', 'security',
    ]);
    expect(new Set(ROLE_TEMPLATES.map(template => template.name)).size).toBe(9);
    for (const template of ROLE_TEMPLATES) {
      expect(template.name).toBe(template.id);
      expect(memberName.parse(template.name)).toBe(template.name);
      expect(template.name).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
      expect(template.name.length).toBeLessThanOrEqual(40);
      expect(template.titleKey).toBe(`role.${template.id}.title`);
      expect(template.descriptionKey).toBe(`role.${template.id}.description`);
      expect(template.instructionsKey).toBe(`role.${template.id}.instructions`);
    }
  });

  it.each(locales)('provides a complete non-empty %s dictionary without extra keys', (_locale, texts) => {
    const keys = ROLE_TEMPLATES.flatMap(template => [template.titleKey, template.descriptionKey, template.instructionsKey]);
    expect(keys).toHaveLength(27);
    expect(Object.keys(texts).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(texts[key].trim()).toBe(texts[key]);
      expect(texts[key].length).toBeGreaterThan(0);
      expect(texts[key].length).toBeLessThanOrEqual(20_000);
      expect(texts[key]).not.toBe(key);
    }
  });

  it('provides distinct bilingual text and role-specific acceptance criteria', () => {
    for (const template of ROLE_TEMPLATES) {
      for (const key of [template.titleKey, template.descriptionKey, template.instructionsKey]) {
        expect(roleTemplateZh[key]).not.toBe(roleTemplateEn[key]);
        expect(roleTemplateZh[key]).toMatch(/[\u3400-\u9fff]/);
      }
      const en = roleTemplateEn[template.instructionsKey];
      const zh = roleTemplateZh[template.instructionsKey];
      for (const phrase of ['assigned task', 'write scopes', 'no authorization', 'save or start', 'explicit authorization', 'Acceptance:']) {
        expect(en).toContain(phrase);
      }
      for (const phrase of ['分配的任务', '写入范围', '不授权保存或启动', '明确授权', '验收']) {
        expect(zh).toContain(phrase);
      }
    }
    expect(new Set(ROLE_TEMPLATES.map(template => roleTemplateEn[template.instructionsKey])).size).toBe(9);
    expect(new Set(ROLE_TEMPLATES.map(template => roleTemplateZh[template.instructionsKey])).size).toBe(9);
  });
});

describe('createRoleMember', () => {
  it.each(ROLE_TEMPLATES)('creates valid editable member data for $id in either language', template => {
    for (const [, texts] of locales) {
      const member = createRoleMember(template.id, [], key => texts[key]);
      expect(member).toEqual({
        name: template.name,
        role: texts[template.titleKey],
        instructions: texts[template.instructionsKey],
      });
      expect(memberInput.parse(member)).toEqual(member);
      expect(Object.keys(member).sort()).toEqual(['instructions', 'name', 'role']);
      expect(Object.isFrozen(member)).toBe(false);
    }
  });

  it('uses the supplied translator for the short role title and instructions only', () => {
    const translate = vi.fn((key: RoleTemplateTextKey) => `translated:${key}`);
    expect(createRoleMember('architect', [], translate)).toEqual({
      name: 'architect',
      role: 'translated:role.architect.title',
      instructions: 'translated:role.architect.instructions',
    });
    expect(translate.mock.calls).toEqual([['role.architect.title'], ['role.architect.instructions']]);
  });

  it.each(ROLE_TEMPLATES)('increments exact name collisions for $id without modifying input', template => {
    const existingNames = Object.freeze([template.name, `${template.name}-2`, `${template.name}-3`, 'captain']);
    const member = createRoleMember(template.id, existingNames, translateEn);
    expect(member.name).toBe(`${template.name}-4`);
    expect(memberInput.parse(member)).toEqual(member);
    expect(existingNames).toEqual([template.name, `${template.name}-2`, `${template.name}-3`, 'captain']);
  });

  it('chooses the first available suffix and does not confuse prefixes or duplicate entries', () => {
    expect(createRoleMember('tester', ['tester', 'tester', 'tester-3', 'tester-20'], translateEn).name).toBe('tester-2');
    expect(createRoleMember('tester', ['tester-2', 'tester-3', 'tester-extra'], translateEn).name).toBe('tester');
  });

  it.each(ROLE_TEMPLATES)('keeps heavily repeated $id names unique and within 40 characters', template => {
    const existingNames = Array.from({ length: 100 }, (_, index) => index === 0 ? template.name : `${template.name}-${index + 1}`);
    const member = createRoleMember(template.id, existingNames, translateZh);
    expect(member.name).toBe(`${template.name}-101`);
    expect(existingNames).not.toContain(member.name);
    expect(member.name.length).toBeLessThanOrEqual(40);
    expect(memberName.parse(member.name)).toBe(member.name);
  });

  it.each(['', 'unknown', 'Architect', ' architect', 'architect ', 'toString', 'constructor', '__proto__', 'a'.repeat(41)])(
    'rejects an unknown template id %j before translating anything', templateId => {
      const translate = vi.fn(translateEn);
      expect(() => createRoleMember(templateId, [], translate)).toThrow(RangeError);
      expect(() => createRoleMember(templateId, [], translate)).toThrow('Unknown role template:');
      expect(translate).not.toHaveBeenCalled();
    },
  );

  it('returns fresh independent drafts without reserving names or mutating templates', () => {
    const templatesBefore = structuredClone(ROLE_TEMPLATES);
    const englishBefore = { ...roleTemplateEn };
    const chineseBefore = { ...roleTemplateZh };
    const existingNames = Object.freeze(['frontend']);
    const first = createRoleMember('frontend', existingNames, translateEn);
    const second = createRoleMember('frontend', existingNames, translateEn);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    first.name = 'custom-frontend'; first.role = 'Custom role'; first.instructions = 'Custom instructions';
    expect(second).toEqual(createRoleMember('frontend', existingNames, translateEn));
    expect(ROLE_TEMPLATES).toEqual(templatesBefore);
    expect(roleTemplateEn).toEqual(englishBefore);
    expect(roleTemplateZh).toEqual(chineseBefore);
    expect(existingNames).toEqual(['frontend']);
  });

  it('does not call network or browser persistence when filling a draft', () => {
    const forbiddenEffect = vi.fn(() => { throw new Error('Draft templates must not produce external effects'); });
    vi.stubGlobal('fetch', forbiddenEffect);
    const storage = { getItem: forbiddenEffect, setItem: forbiddenEffect, removeItem: forbiddenEffect, clear: forbiddenEffect };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    for (const template of ROLE_TEMPLATES) {
      const draft = createRoleMember(template.id, [], translateEn);
      expect(memberInput.parse(draft)).toEqual(draft);
      expect(draft).not.toHaveProperty('sessionId');
      expect(draft).not.toHaveProperty('status');
      expect(draft).not.toHaveProperty('tasks');
    }
    expect(forbiddenEffect).not.toHaveBeenCalled();
  });
});
