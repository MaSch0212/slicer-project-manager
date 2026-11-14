import { unzipSync } from 'three/addons/libs/fflate.module.js'
import type { TreeNode } from '../ui/code-view'

/**
 * Reading a zip in the browser for the archive preview: its entries as a tree, and one entry's
 * bytes on demand. The inflater is the one three.js already ships (fflate), as a module of its
 * own, so this pulls in no renderer.
 *
 * Listing inflates nothing: fflate's filter sees each entry's name and sizes from the central
 * directory, and refusing every one of them is a listing.
 */

export interface ArchiveEntry {
  path: string
  /** Bytes once extracted. */
  size: number
}

/** Every file entry of the zip (folders are implied by the paths). Throws for a non-zip. */
export function listEntries(bytes: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  unzipSync(bytes, {
    filter: (file) => {
      if (!file.name.endsWith('/')) entries.push({ path: file.name, size: file.originalSize })
      return false
    },
  })
  return entries
}

/** One entry's extracted bytes, or undefined when there is no such entry. */
export function readEntry(bytes: Uint8Array, path: string): Uint8Array | undefined {
  return unzipSync(bytes, { filter: (file) => file.name === path })[path]
}

/**
 * The entries as a tree: folders first, then files, each by name. A folder's size is what its
 * contents add up to. Backslashes count as separators too (some Windows tools write them), and
 * empty segments are dropped, so `a//b` is `a/b`.
 */
export function entryTree(entries: readonly ArchiveEntry[]): TreeNode[] {
  type Folder = { node: TreeNode; folders: Map<string, Folder> }
  const root: Folder = { node: { name: '', path: '', size: 0, children: [] }, folders: new Map() }
  for (const entry of entries) {
    const parts = entry.path.split(/[\\/]/).filter(Boolean)
    const name = parts.pop()
    if (!name) continue
    let folder = root
    folder.node.size += entry.size
    for (const part of parts) {
      let next = folder.folders.get(part)
      if (!next) {
        const path = folder.node.path ? `${folder.node.path}/${part}` : part
        next = { node: { name: part, path, size: 0, children: [] }, folders: new Map() }
        folder.folders.set(part, next)
        folder.node.children!.push(next.node)
      }
      next.node.size += entry.size
      folder = next
    }
    folder.node.children!.push({ name, path: entry.path, size: entry.size })
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .sort(
        (a, b) =>
          Number(b.children !== undefined) - Number(a.children !== undefined) ||
          collator.compare(a.name, b.name),
      )
      .map((node) => (node.children ? { ...node, children: sort(node.children) } : node))
  return sort(root.node.children!)
}

/** The folders to open at first: down a chain of single folders, so a wrapped archive shows. */
export function initiallyOpen(nodes: readonly TreeNode[]): string[] {
  const open: string[] = []
  let level = nodes
  while (level.length === 1 && level[0]!.children) {
    open.push(level[0]!.path)
    level = level[0]!.children!
  }
  return open
}
