import { createDecorators } from '@spm/contract/decorate.ts'

/**
 * The server's file-URL base. Everything the routes serve lives under `/api` (spec 5.1), so
 * `decorateFile` emits `/api/files/<id>/raw` exactly as it did when the three functions were
 * written out longhand here.
 *
 * The bodies moved to `@spm/contract` because the Electron shell needs the same three functions
 * against a different base, and two copies of twenty lines that must agree on a DTO shape is the
 * alternative. Nothing about the server's output changed: `test/files.test.ts` asserts these
 * exact strings over real HTTP, and `packages/contract/test/decorate.test.ts` pins the
 * serialised bytes of both bases side by side.
 */
export const SERVER_FILE_URL_BASE = '/api'

export const { decorateFile, decorateProject, decorateProjectDetail } =
  createDecorators(SERVER_FILE_URL_BASE)
