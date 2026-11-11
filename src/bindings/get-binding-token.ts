/**
 * Returns the Nest injection token for a native Cloudflare binding.
 *
 * @publicApi
 */
export function getBindingToken<Env extends object = Record<string, unknown>>(
  name: Extract<keyof Env, string>,
): string {
  return `cloudflare:binding:${name}`;
}
