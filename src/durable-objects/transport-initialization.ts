import type { INestApplicationContext, InjectionToken } from '@nestjs/common';
import {
  DiscoveryService,
  MetadataScanner,
  ModulesContainer,
  Reflector,
} from '@nestjs/core';
import type { MessageHandler, MsPattern } from '@nestjs/microservices';
import {
  PATTERN_METADATA,
  TRANSPORT_METADATA,
} from '@nestjs/microservices/constants';

import { getDurableObjectContextId } from './context.js';
import type { CloudflareDurableObjectServer } from './server.js';

export type TransportControllerInitializer = (pattern: string) => Promise<void>;

/** Shares controller resolution only among this object's matching events. */
export function createTransportControllerInitializer(
  app: INestApplicationContext,
  server: CloudflareDurableObjectServer,
  state: DurableObjectState,
): TransportControllerInitializer {
  const controllers = discoverTransportControllers(app, server);
  const resolutions = new Map<InjectionToken, Promise<void>>();

  function resolve(token: InjectionToken): Promise<void> {
    let resolution = resolutions.get(token);

    if (!resolution) {
      const contextId = getDurableObjectContextId(state);

      app.registerRequestByContextId(contextId.payload, contextId);

      resolution = app
        .resolve(token, contextId, { strict: false, each: true })
        .then(() => undefined)
        .catch((error: unknown) => {
          resolutions.delete(token);
          throw error;
        });

      resolutions.set(token, resolution);
    }

    return resolution;
  }

  return pattern => {
    const handler = server.getHandlerByPattern(pattern);
    const tokens = handler && controllers.get(handler);

    return tokens
      ? Promise.all(tokens.map(resolve)).then(() => undefined)
      : Promise.resolve();
  };
}

function discoverTransportControllers(
  app: INestApplicationContext,
  server: CloudflareDurableObjectServer,
): Map<MessageHandler, InjectionToken[]> {
  const discovery = new DiscoveryService(app.get(ModulesContainer));
  const scanner = new MetadataScanner();
  const reflector = new Reflector();
  const controllers = new Map<MessageHandler, InjectionToken[]>();

  for (const controller of discovery.getControllers()) {
    const prototype: object | undefined = controller.metatype?.prototype;

    if (!prototype) {
      continue;
    }

    for (const name of scanner.getAllMethodNames(prototype)) {
      const method: unknown = Reflect.get(prototype, name);

      for (const handler of getTransportHandlers(method, server, reflector)) {
        const tokens = handler.isEventHandler
          ? (controllers.get(handler) ?? [])
          : [];

        controllers.set(handler, [...new Set([...tokens, controller.token])]);
      }
    }
  }

  return controllers;
}

function getTransportHandlers(
  method: unknown,
  server: CloudflareDurableObjectServer,
  reflector: Reflector,
): MessageHandler[] {
  if (typeof method !== 'function') {
    return [];
  }

  const transport = reflector.get<unknown>(TRANSPORT_METADATA, method);

  if (transport !== undefined && transport !== server.transportId) {
    return [];
  }

  const patterns = reflector.get<MsPattern[] | undefined>(
    PATTERN_METADATA,
    method,
  );

  return (patterns ?? []).flatMap(pattern => {
    const route =
      typeof pattern === 'string' ? pattern : JSON.stringify(pattern);

    const handler = server.getHandlerByPattern(route);

    return handler ? [handler] : [];
  });
}
