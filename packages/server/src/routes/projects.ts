import type { ProjectQuery } from '@spm/contract/dtos.ts'
import {
  createProjectSchema,
  projectPatchSchema,
  projectQuerySchema,
  tagBodySchema,
} from '@spm/contract/schemas.ts'
import {
  addTag,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  removeTag,
  rescan,
  updateProject,
} from '@spm/core'
import { decorateProject, decorateProjectDetail } from '../decorate.ts'
import { json, noContent, parseJson } from '../json.ts'
import type { Route } from '../router.ts'

/** Query strings are all text; coerce, then validate with the shared schema. */
export function parseProjectQuery(url: URL): ProjectQuery {
  const raw = {
    ...(url.searchParams.get('search') ? { search: url.searchParams.get('search')! } : {}),
    ...(url.searchParams.getAll('tags').length ? { tags: url.searchParams.getAll('tags') } : {}),
    ...(url.searchParams.has('includeArchived')
      ? { includeArchived: url.searchParams.get('includeArchived') === 'true' }
      : {}),
    ...(url.searchParams.get('sort') ? { sort: url.searchParams.get('sort')! } : {}),
    ...(url.searchParams.get('dir') ? { dir: url.searchParams.get('dir')! } : {}),
  }
  const parsed = projectQuerySchema.safeParse(raw)
  // An unparseable query is treated as no query rather than as an error page.
  return parsed.success ? parsed.data : {}
}

export const projectRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/projects',
    auth: 'session',
    handler: ({ url, env, ctx }) =>
      json(listProjects(env.lib, ctx, parseProjectQuery(url)).map(decorateProject)),
  },
  {
    method: 'POST',
    path: '/api/projects',
    auth: 'session',
    handler: async ({ req, env, ctx }) => {
      const input = await parseJson(req, createProjectSchema)
      return json(decorateProject(createProject(env.lib, ctx, input)))
    },
  },
  // Must precede /api/projects/:id so "rescan" is never read as an id.
  {
    method: 'POST',
    path: '/api/projects/rescan',
    auth: 'session',
    handler: async ({ env, ctx }) => json(await rescan(env.lib, ctx)),
  },
  {
    method: 'GET',
    path: '/api/projects/:id',
    auth: 'session',
    handler: ({ params, env, ctx }) =>
      json(decorateProjectDetail(getProject(env.lib, ctx, params.id!))),
  },
  {
    method: 'PATCH',
    path: '/api/projects/:id',
    auth: 'session',
    handler: async ({ req, params, env, ctx }) => {
      const patch = await parseJson(req, projectPatchSchema)
      return json(decorateProject(updateProject(env.lib, ctx, params.id!, patch)))
    },
  },
  {
    method: 'DELETE',
    path: '/api/projects/:id',
    auth: 'session',
    handler: ({ url, params, env, ctx }) => {
      deleteProject(env.lib, ctx, params.id!, {
        deleteFiles: url.searchParams.get('deleteFiles') === 'true',
      })
      return noContent()
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/tags',
    auth: 'session',
    handler: async ({ req, params, env, ctx }) => {
      const { name } = await parseJson(req, tagBodySchema)
      addTag(env.lib, ctx, params.id!, name)
      return noContent()
    },
  },
  {
    method: 'DELETE',
    path: '/api/projects/:id/tags/:name',
    auth: 'session',
    handler: ({ params, env, ctx }) => {
      removeTag(env.lib, ctx, params.id!, decodeURIComponent(params.name!))
      return noContent()
    },
  },
]
