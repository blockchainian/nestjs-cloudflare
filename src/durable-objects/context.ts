import type { INestApplicationContext, InjectionToken } from '@nestjs/common';
import {
  type ContextId,
  ContextIdFactory,
  type ContextIdStrategy,
  type HostComponentInfo,
} from '@nestjs/core';

const owners = new WeakMap<object, DurableObjectState>();
const contexts = new WeakMap<DurableObjectState, ContextId>();
let installed = false;

/** Groups durable dependency trees by their owning Durable Object activation. */
export class DurableObjectContextIdStrategy implements ContextIdStrategy<object> {
  public attach(contextId: ContextId, request: object) {
    const ctx = owners.get(request) ?? getWrappedOwner(request);

    if (!ctx) {
      return;
    }

    let parent = contexts.get(ctx);

    if (!parent) {
      parent = ContextIdFactory.create();
      contexts.set(ctx, parent);
    }

    const durableContextId = parent;

    return {
      resolve: (info: HostComponentInfo) =>
        info.isTreeDurable ? durableContextId : contextId,
      payload: { durableObjectId: ctx.id.toString(), ctx },
    };
  }
}

/** Associates a native event source with its object's Nest dependency tree. */
export function attachDurableObjectContext(
  source: object,
  ctx: DurableObjectState,
): void {
  if (!installed) {
    ContextIdFactory.apply(new DurableObjectContextIdStrategy());
    installed = true;
  }

  owners.set(source, ctx);
}

/** Creates an event context whose durable providers belong to this object. */
export function getDurableObjectContextId(ctx: DurableObjectState): ContextId {
  const event = {};

  attachDurableObjectContext(event, ctx);

  return ContextIdFactory.getByRequest(event);
}

/** Resolves a provider for fetch, alarm, or RPC in the current object. */
export function resolveForDurableObject<T>(
  app: INestApplicationContext,
  ctx: DurableObjectState,
  token: InjectionToken<T>,
): Promise<T> {
  const contextId = getDurableObjectContextId(ctx);

  app.registerRequestByContextId(contextId.payload, contextId);

  return app.resolve<T>(token, contextId, { strict: false });
}

/** Reads the public Nest RequestContext wrapper without depending on Nest internals. */
function getWrappedOwner(request: object): DurableObjectState | undefined {
  if (!('getContext' in request) || typeof request.getContext !== 'function') {
    return;
  }

  const context: unknown = request.getContext();

  return context !== null && typeof context === 'object'
    ? owners.get(context)
    : undefined;
}
