import path from 'node:path'

export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * SPEC §9.5 invariant 2: a path must resolve to somewhere inside its root.
 *
 * The comparison is on the *relative* path rather than a string prefix, so
 * `/root-2` is not treated as being inside `/root`. Note that a bare
 * `startsWith('..')` is too coarse — it also rejects legitimate names that
 * merely begin with two dots, like `..foo` — so an escape is only `..` itself
 * or a segment boundary after it.
 */
export function checkContainment(targetPath: string, root: string): void {
  const absPath = path.resolve(targetPath)
  const absRoot = path.resolve(root)
  const relative = path.relative(absRoot, absPath)
  const escapes = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
  if (escapes) {
    throw new Error(`Path ${absPath} is not contained within root ${absRoot}`)
  }
}
