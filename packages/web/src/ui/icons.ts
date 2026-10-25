/**
 * The one icon set (Lucide). Feature code imports icons from here, never from `lucide-solid`
 * directly, so swapping the set is one file. Each icon is imported from its own module: the
 * package's barrel would make the dev server load all ~1,700 of them. Add to this list as screens
 * need icons.
 */
export { default as AlertTriangle } from 'lucide-solid/icons/triangle-alert'
export { default as Archive } from 'lucide-solid/icons/archive'
export { default as ArrowLeft } from 'lucide-solid/icons/arrow-left'
export { default as Check } from 'lucide-solid/icons/check'
export { default as ChevronDown } from 'lucide-solid/icons/chevron-down'
export { default as ChevronRight } from 'lucide-solid/icons/chevron-right'
export { default as CircleAlert } from 'lucide-solid/icons/circle-alert'
export { default as CircleCheck } from 'lucide-solid/icons/circle-check'
export { default as Download } from 'lucide-solid/icons/download'
export { default as ExternalLink } from 'lucide-solid/icons/external-link'
export { default as FileBox } from 'lucide-solid/icons/file-box'
export { default as FolderOpen } from 'lucide-solid/icons/folder-open'
export { default as Globe } from 'lucide-solid/icons/globe'
export { default as Info } from 'lucide-solid/icons/info'
export { default as Layers } from 'lucide-solid/icons/layers'
export { default as LayoutGrid } from 'lucide-solid/icons/layout-grid'
export { default as List } from 'lucide-solid/icons/list'
export { default as LogOut } from 'lucide-solid/icons/log-out'
export { default as MenuIcon } from 'lucide-solid/icons/menu'
export { default as Monitor } from 'lucide-solid/icons/monitor'
export { default as Moon } from 'lucide-solid/icons/moon'
export { default as MoreHorizontal } from 'lucide-solid/icons/ellipsis'
export { default as PanelLeftClose } from 'lucide-solid/icons/panel-left-close'
export { default as PanelLeftOpen } from 'lucide-solid/icons/panel-left-open'
export { default as Pencil } from 'lucide-solid/icons/pencil'
export { default as Plus } from 'lucide-solid/icons/plus'
export { default as Search } from 'lucide-solid/icons/search'
export { default as Settings } from 'lucide-solid/icons/settings'
export { default as Sun } from 'lucide-solid/icons/sun'
export { default as TagIcon } from 'lucide-solid/icons/tag'
export { default as Trash2 } from 'lucide-solid/icons/trash'
export { default as Upload } from 'lucide-solid/icons/upload'
export { default as Users } from 'lucide-solid/icons/users'
export { default as X } from 'lucide-solid/icons/x'

import type { Component } from 'solid-js'
import type { LucideProps } from 'lucide-solid'

export type { LucideProps as IconProps }

/** An icon component, as the library's `icon` props take it. */
export type IconComponent = Component<LucideProps>
