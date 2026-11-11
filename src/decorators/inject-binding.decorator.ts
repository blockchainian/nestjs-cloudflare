import { Inject } from '@nestjs/common';

import { getBindingToken } from '../bindings/get-binding-token.js';

/**
 * Injects a binding registered from the native Cloudflare environment.
 *
 * @publicApi
 */
export function InjectBinding<Env extends object = Record<string, unknown>>(
  name: Extract<keyof Env, string>,
): ReturnType<typeof Inject> {
  return Inject(getBindingToken<Env>(name));
}
