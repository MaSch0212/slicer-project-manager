import type {
  Capabilities,
  CreateProjectInput,
  CreateUserInput,
  FileDto,
  ProjectDetailDto,
  ProjectDto,
  ProjectPatch,
  ProjectQuery,
  RescanResultDto,
  SettingsDto,
  SettingsPatch,
  UpdateUserInput,
  UserDto,
  ZipImportResultDto,
} from '../../api/generated'
import { ApiError, errorFromResponse } from './error'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** A body for the two upload routes: a `Blob` (a `File` is one) sent as-is. */
export type UploadBody = Blob

export type ActivationCheck = { valid: boolean; username?: string }

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const seg = encodeURIComponent

/**
 * The REST API over `fetch` (migration spec 3.3: HTTP everywhere). Same-origin, always with
 * credentials, because the session cookie is httpOnly and rides on the request itself.
 *
 * A factory, not a module of loose functions, so a test can hand it a fake `fetch`.
 */
export function createApiClient(fetchFn: FetchLike = (input, init) => fetch(input, init)) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response
    try {
      response = await fetchFn(path, { ...init, credentials: 'include' })
    } catch (cause) {
      // A network failure is the one place no envelope exists to read.
      throw new ApiError('Internal', cause instanceof Error ? cause.message : 'network error')
    }
    if (response.status === 204) return undefined as T
    if (!response.ok) throw await errorFromResponse(response)
    try {
      return (await response.json()) as T
    } catch {
      // A 200 that is not JSON is the static handler answering an unknown path with index.html.
      throw new ApiError('Internal', 'the server returned an unparseable body', {
        status: response.status,
      })
    }
  }

  // No content-length here: it is a forbidden header name, and fetch derives it from the Blob.
  const upload = <T>(path: string, body: UploadBody, headers: Record<string, string> = {}) =>
    request<T>(path, { method: 'POST', headers, body })

  return {
    capabilities: () => request<Capabilities>('/api/capabilities'),

    auth: {
      login: (username: string, password: string) =>
        request<UserDto>('/api/auth/login', jsonInit('POST', { username, password })),
      logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
      checkToken: (token: string) => request<ActivationCheck>(`/api/auth/activation/${seg(token)}`),
      activate: (token: string, password: string) =>
        request<UserDto>(
          `/api/auth/activation/${seg(token)}`,
          jsonInit('POST', { password, confirm: password }),
        ),
    },

    account: {
      me: () => request<UserDto>('/api/account'),
      changePassword: (current: string, next: string) =>
        request<void>('/api/account/password', jsonInit('POST', { current, next })),
      updateProfile: (patch: { displayName?: string }) =>
        request<UserDto>('/api/account', jsonInit('PATCH', patch)),
    },

    settings: {
      get: () => request<SettingsDto>('/api/account/settings'),
      put: (patch: SettingsPatch) =>
        request<SettingsDto>('/api/account/settings', jsonInit('PUT', patch)),
    },

    users: {
      list: () => request<UserDto[]>('/api/users'),
      create: (input: CreateUserInput) =>
        request<{ user: UserDto; activationUrl: string }>('/api/users', jsonInit('POST', input)),
      reissueInvite: (id: string) =>
        request<{ activationUrl: string }>(`/api/users/${seg(id)}/invite`, { method: 'POST' }),
      update: (id: string, patch: UpdateUserInput) =>
        request<UserDto>(`/api/users/${seg(id)}`, jsonInit('PATCH', patch)),
      delete: (id: string) => request<void>(`/api/users/${seg(id)}`, { method: 'DELETE' }),
    },

    projects: {
      list: (query: ProjectQuery = {}) => {
        const params = new URLSearchParams()
        if (query.search) params.set('search', query.search)
        for (const tag of query.tags ?? []) params.append('tags', tag)
        if (query.includeArchived) params.set('includeArchived', 'true')
        if (query.sort) params.set('sort', query.sort)
        if (query.dir) params.set('dir', query.dir)
        if (query.limit !== undefined) params.set('limit', String(query.limit))
        if (query.offset !== undefined) params.set('offset', String(query.offset))
        const suffix = params.size > 0 ? `?${params.toString()}` : ''
        return request<ProjectDto[]>(`/api/projects${suffix}`)
      },
      get: (id: string) => request<ProjectDetailDto>(`/api/projects/${seg(id)}`),
      create: (input: CreateProjectInput) =>
        request<ProjectDto>('/api/projects', jsonInit('POST', input)),
      update: (id: string, patch: ProjectPatch) =>
        request<ProjectDto>(`/api/projects/${seg(id)}`, jsonInit('PATCH', patch)),
      delete: (id: string, options: { deleteFiles: boolean }) =>
        request<void>(`/api/projects/${seg(id)}?deleteFiles=${options.deleteFiles}`, {
          method: 'DELETE',
        }),
      addTag: (id: string, name: string) =>
        request<void>(`/api/projects/${seg(id)}/tags`, jsonInit('POST', { name })),
      removeTag: (id: string, name: string) =>
        request<void>(`/api/projects/${seg(id)}/tags/${seg(name)}`, { method: 'DELETE' }),
      rescan: () => request<RescanResultDto>('/api/projects/rescan', { method: 'POST' }),
      tags: () => request<string[]>('/api/projects/tags'),
    },

    importer: {
      curaManagerZip: (body: UploadBody) =>
        upload<ZipImportResultDto>('/api/import/curamanager', body),
    },

    files: {
      upload: (projectId: string, name: string, body: UploadBody) =>
        upload<FileDto>(`/api/projects/${seg(projectId)}/files`, body, {
          'x-spm-file-name': seg(name),
        }),
      rename: (id: string, name: string) =>
        request<FileDto>(`/api/files/${seg(id)}`, jsonInit('PATCH', { name })),
      delete: (id: string) => request<void>(`/api/files/${seg(id)}`, { method: 'DELETE' }),
    },
  }
}

export type ApiClient = ReturnType<typeof createApiClient>

/** The app's client. Stores take an `ApiClient` so tests can pass their own. */
export const api: ApiClient = createApiClient()
