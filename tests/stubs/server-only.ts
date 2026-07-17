// Stub for the "server-only" package under Vitest, which has no React Server
// Components boundary. In the real app, importing server-only in a client bundle is a
// build error — that guard is intact; this only satisfies the node test runtime.
export {}
