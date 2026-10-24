// path may hold a bare PropertyKey or a { key } wrapper — the official Standard Schema spec
// allows both, and zod's generated types use the wrapper form, so narrowing to PropertyKey
// alone makes a real zod schema fail to structurally satisfy this type.
type StandardIssue = {
  message: string
  path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>
}

export type StandardSchemaV1<T> = {
  '~standard': {
    validate: (
      value: unknown,
    ) =>
      | { value: T; issues?: undefined }
      | { issues: ReadonlyArray<StandardIssue> }
      | Promise<{ value: T; issues?: undefined } | { issues: ReadonlyArray<StandardIssue> }>
  }
}
