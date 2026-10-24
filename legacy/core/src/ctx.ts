/** Every use case takes one of these. Ownership is scoped by userId inside core (spec 2.2). */
export type Ctx = { userId: string; isAdmin: boolean }
