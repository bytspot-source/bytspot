/**
 * How /trpc is served. A query may also be sent as a POST with its input in
 * the body: the server refuses a request whose URL and headers pass about
 * 16 KB (HTTP 431), and Discover's ranking sends every card it shows. Only
 * queries gain a method; a mutation still answers POST alone.
 */
export const TRPC_HTTP_OPTIONS = { allowMethodOverride: true } as const;
