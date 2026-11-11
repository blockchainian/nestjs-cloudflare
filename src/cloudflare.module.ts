import {
  type DynamicModule,
  Global,
  Module,
  type ValueProvider,
} from '@nestjs/common';
import { env } from 'cloudflare:workers';

import { getBindingToken } from './bindings/get-binding-token.js';
import { CLOUDFLARE_ENV } from './constants.js';

/**
 * Makes the native Cloudflare environment and its bindings available to Nest.
 *
 * @publicApi
 */
@Global()
@Module({})
export class CloudflareModule {
  /** Registers the environment's bindings once in the application's root module. */
  public static forRoot(): DynamicModule {
    const bindings: ValueProvider<unknown>[] = [];

    for (const name of Object.keys(env)) {
      const binding: unknown = Reflect.get(env, name);

      if (hasModuleInitHook(binding)) {
        continue;
      }

      bindings.push({ provide: getBindingToken(name), useValue: binding });
    }

    return {
      module: CloudflareModule,
      providers: [{ provide: CLOUDFLARE_ENV, useValue: env }, ...bindings],
      exports: [CLOUDFLARE_ENV, ...bindings.map(binding => binding.provide)],
    };
  }
}

/** RPC stubs expose callable properties that Nest would invoke as lifecycle hooks. */
function hasModuleInitHook(binding: unknown): boolean {
  return (
    binding !== null &&
    (typeof binding === 'object' || typeof binding === 'function') &&
    typeof Reflect.get(binding, 'onModuleInit') === 'function'
  );
}
