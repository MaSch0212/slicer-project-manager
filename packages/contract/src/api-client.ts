import type {
  Capabilities,
  ProjectDetailDto,
  ProjectDto,
  ProjectQuery,
  FileDto,
  RescanResultDto,
  SettingsDto,
  UserDto,
} from './dtos.ts'
import type {
  CreateProjectInput,
  CreateUserInput,
  ProjectPatchInput,
  SettingsPatchInput,
  UpdateUserInput,
} from './schemas.ts'

/**
 * Two arms because the two shells cannot upload the same way.
 *
 * `blob` is the browser's arm: `Content-Length` is a forbidden header name in the Fetch
 * standard, so a script-set one is silently stripped, and a `ReadableStream` body has no
 * length the browser could compute for itself. Handing fetch a `Blob` (the `File` an
 * `<input type="file">` yields is one) lets it set the header, which the server hard-requires
 * before it writes a byte (spec 5.6). It also avoids `duplex: 'half'` request streaming,
 * which is Chromium-and-HTTP/2-only.
 *
 * `stream` stays for the Node, Deno and Electron shells, which may set `Content-Length`
 * themselves and do support request streaming, so they can upload without buffering the file.
 */
export type UploadBody = { blob: Blob } | { stream: ReadableStream<Uint8Array>; sizeBytes: number }

export interface ApiClient {
  capabilities(): Promise<Capabilities>

  auth: {
    login(username: string, password: string): Promise<UserDto>
    logout(): Promise<void>
    checkToken(token: string): Promise<{ valid: boolean; username?: string }>
    activate(token: string, newPassword: string): Promise<UserDto>
  }

  account: {
    me(): Promise<UserDto>
    changePassword(current: string, next: string): Promise<void>
    updateProfile(patch: { displayName?: string }): Promise<UserDto>
  }

  settings: {
    get(): Promise<SettingsDto>
    put(patch: SettingsPatchInput): Promise<SettingsDto>
  }

  users: {
    list(): Promise<UserDto[]>
    create(dto: CreateUserInput): Promise<{ user: UserDto; activationUrl: string }>
    reissueInvite(id: string): Promise<{ activationUrl: string }>
    update(id: string, patch: UpdateUserInput): Promise<UserDto>
    delete(id: string): Promise<void>
  }

  projects: {
    list(query: ProjectQuery): Promise<ProjectDto[]>
    get(id: string): Promise<ProjectDetailDto>
    create(dto: CreateProjectInput): Promise<ProjectDto>
    update(id: string, patch: ProjectPatchInput): Promise<ProjectDto>
    delete(id: string, opts: { deleteFiles: boolean }): Promise<void>
    addTag(id: string, name: string): Promise<void>
    removeTag(id: string, name: string): Promise<void>
    rescan(): Promise<RescanResultDto>
  }

  files: {
    upload(projectId: string, name: string, body: UploadBody): Promise<FileDto>
    rename(id: string, name: string): Promise<FileDto>
    delete(id: string): Promise<void>
  }
}
