import type { ApiClient, UploadBody } from '@spm/contract/api-client.ts'
import type {
  Capabilities,
  ProjectDetailDto,
  ProjectDto,
  ProjectQuery,
  FileDto,
  RescanResultDto,
  SettingsDto,
  UserDto,
} from '@spm/contract/dtos.ts'
import { AppError, type AppErrorCode } from '@spm/contract/errors.ts'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class HttpApiClient implements ApiClient {
  private readonly baseUrl: string
  private readonly fetchFn: FetchLike

  constructor(baseUrl = '', fetchFn: FetchLike = (input, init) => fetch(input, init)) {
    this.baseUrl = baseUrl
    this.fetchFn = fetchFn
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      // The session cookie is httpOnly, so it must ride on the request itself (spec 5.2).
      credentials: 'include',
    })
    if (response.status === 204) return undefined as T
    if (!response.ok) throw await this.toError(response)
    return (await response.json()) as T
  }

  private async toError(response: Response): Promise<AppError> {
    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string; details?: Record<string, unknown> }
      }
      if (body.error?.code) {
        return new AppError(
          body.error.code as AppErrorCode,
          body.error.message ?? 'request failed',
          body.error.details,
        )
      }
    } catch {
      // Fall through: a proxy or gateway answered with something that is not our envelope.
    }
    return new AppError('Internal', `request failed with status ${response.status}`)
  }

  private json(method: string, body: unknown): RequestInit {
    return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  }

  capabilities(): Promise<Capabilities> {
    return this.request('/api/capabilities')
  }

  readonly auth = {
    login: (username: string, password: string): Promise<UserDto> =>
      this.request('/api/auth/login', this.json('POST', { username, password })),
    logout: (): Promise<void> => this.request('/api/auth/logout', { method: 'POST' }),
    checkToken: (token: string): Promise<{ valid: boolean; username?: string }> =>
      this.request(`/api/auth/activation/${encodeURIComponent(token)}`),
    activate: (token: string, newPassword: string): Promise<UserDto> =>
      this.request(
        `/api/auth/activation/${encodeURIComponent(token)}`,
        this.json('POST', { password: newPassword, confirm: newPassword }),
      ),
  }

  readonly account = {
    me: (): Promise<UserDto> => this.request('/api/account'),
    changePassword: (current: string, next: string): Promise<void> =>
      this.request('/api/account/password', this.json('POST', { current, next })),
    updateProfile: (patch: { displayName?: string }): Promise<UserDto> =>
      this.request('/api/account', this.json('PATCH', patch)),
  }

  readonly settings = {
    get: (): Promise<SettingsDto> => this.request('/api/account/settings'),
    put: (patch: Partial<SettingsDto>): Promise<SettingsDto> =>
      this.request('/api/account/settings', this.json('PUT', patch)),
  }

  readonly users = {
    list: (): Promise<UserDto[]> => this.request('/api/users'),
    create: (dto: unknown): Promise<{ user: UserDto; activationUrl: string }> =>
      this.request('/api/users', this.json('POST', dto)),
    reissueInvite: (id: string): Promise<{ activationUrl: string }> =>
      this.request(`/api/users/${id}/invite`, { method: 'POST' }),
    update: (id: string, patch: unknown): Promise<UserDto> =>
      this.request(`/api/users/${id}`, this.json('PATCH', patch)),
    delete: (id: string): Promise<void> => this.request(`/api/users/${id}`, { method: 'DELETE' }),
  }

  readonly projects = {
    list: (query: ProjectQuery): Promise<ProjectDto[]> => {
      const params = new URLSearchParams()
      if (query.search) params.set('search', query.search)
      for (const tag of query.tags ?? []) params.append('tags', tag)
      if (query.includeArchived) params.set('includeArchived', 'true')
      if (query.sort) params.set('sort', query.sort)
      if (query.dir) params.set('dir', query.dir)
      const suffix = params.size > 0 ? `?${params.toString()}` : ''
      return this.request(`/api/projects${suffix}`)
    },
    get: (id: string): Promise<ProjectDetailDto> => this.request(`/api/projects/${id}`),
    create: (dto: unknown): Promise<ProjectDto> =>
      this.request('/api/projects', this.json('POST', dto)),
    update: (id: string, patch: unknown): Promise<ProjectDto> =>
      this.request(`/api/projects/${id}`, this.json('PATCH', patch)),
    delete: (id: string, opts: { deleteFiles: boolean }): Promise<void> =>
      this.request(`/api/projects/${id}?deleteFiles=${opts.deleteFiles}`, { method: 'DELETE' }),
    addTag: (id: string, name: string): Promise<void> =>
      this.request(`/api/projects/${id}/tags`, this.json('POST', { name })),
    removeTag: (id: string, name: string): Promise<void> =>
      this.request(`/api/projects/${id}/tags/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    rescan: (): Promise<RescanResultDto> =>
      this.request('/api/projects/rescan', { method: 'POST' }),
  }

  readonly files = {
    upload: (projectId: string, name: string, body: UploadBody): Promise<FileDto> =>
      this.request(`/api/projects/${projectId}/files`, {
        method: 'POST',
        headers: {
          'x-spm-file-name': encodeURIComponent(name),
          'content-length': String(body.sizeBytes),
        },
        body: body.stream,
        // Required by fetch whenever the body is a stream rather than a buffer.
        duplex: 'half',
      } as RequestInit),
    rename: (id: string, name: string): Promise<FileDto> =>
      this.request(`/api/files/${id}`, this.json('PATCH', { name })),
    delete: (id: string): Promise<void> => this.request(`/api/files/${id}`, { method: 'DELETE' }),
  }
}
