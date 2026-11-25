import { getDurableObjectNamespace } from '../bindings/validate-binding.js';
import type { CloudflareWorkerWebSocketRoute } from '../interfaces/worker-options.interface.js';

export function findWebSocketRoute<Env>(
  request: Request,
  routes: readonly CloudflareWorkerWebSocketRoute<Env>[] = [],
): CloudflareWorkerWebSocketRoute<Env> | undefined {
  const path = new URL(request.url).pathname;

  return routes.find(route => route.paths.includes(path));
}

export function forwardWebSocketRequest<Env>(
  request: Request<unknown, IncomingRequestCfProperties>,
  env: Env,
  route: CloudflareWorkerWebSocketRoute<Env>,
): Promise<Response> {
  const namespace = getDurableObjectNamespace(
    env[route.binding],
    route.binding,
  );

  const object =
    typeof route.object === 'function' ? route.object(request) : route.object;

  const id = typeof object === 'string' ? namespace.idFromName(object) : object;

  return namespace.get(id).fetch(request);
}
