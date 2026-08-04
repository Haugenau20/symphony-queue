import { describe, it, expect } from 'vitest'
import { sanitizeWorkspaceKey, checkContainment } from '../src/path_safety.js'

describe('path_safety', () => {
  describe('sanitizeWorkspaceKey', () => {
    it('passes through valid keys', () => {
      expect(sanitizeWorkspaceKey('ABC-123')).toBe('ABC-123')
      expect(sanitizeWorkspaceKey('my_issue.1')).toBe('my_issue.1')
      expect(sanitizeWorkspaceKey('test-branch')).toBe('test-branch')
    })

    it('replaces invalid characters with underscore', () => {
      expect(sanitizeWorkspaceKey('ABC:123')).toBe('ABC_123')
      expect(sanitizeWorkspaceKey('hello world')).toBe('hello_world')
      expect(sanitizeWorkspaceKey('a/b/c')).toBe('a_b_c')
    })

    it('handles empty string', () => {
      expect(sanitizeWorkspaceKey('')).toBe('')
    })
  })

  describe('checkContainment', () => {
    it('accepts path inside root', () => {
      expect(() => checkContainment('/root/workspace', '/root')).not.toThrow()
    })

    it('rejects path outside root', () => {
      expect(() => checkContainment('/outside', '/root')).toThrow()
    })

    it('accepts nested paths inside root', () => {
      expect(() => checkContainment('/root/a/b/c', '/root')).not.toThrow()
    })

    it('rejects traversal out of the root', () => {
      expect(() => checkContainment('/root/../etc/passwd', '/root')).toThrow()
      expect(() => checkContainment('/root/a/../../etc/passwd', '/root')).toThrow()
    })

    it('rejects the parent of the root', () => {
      expect(() => checkContainment('/', '/root')).toThrow()
    })

    it('accepts the root itself', () => {
      expect(() => checkContainment('/root', '/root')).not.toThrow()
    })

    it('rejects a sibling root sharing a string prefix', () => {
      expect(() => checkContainment('/root-2/x', '/root')).toThrow()
    })

    it('accepts a contained name that merely begins with two dots', () => {
      expect(() => checkContainment('/root/..foo', '/root')).not.toThrow()
      expect(() => checkContainment('/root/.._.._etc_passwd', '/root')).not.toThrow()
    })
  })
})
