import type { INestApplicationContext } from '@nestjs/common';
import {
  DiscoveryService,
  MetadataScanner,
  ModulesContainer,
} from '@nestjs/core';
import {
  PATTERN_METADATA,
  TRANSPORT_METADATA,
} from '@nestjs/microservices/constants';

import { getDurableObjectContextId } from './context.js';
import type { CloudflareDurableObjectServer } from './server.js';

/** Resolves transport controllers before concurrent events enter Nest's wrappers. */
export async function initializeTransportControllers(
  app: INestApplicationContext,
  server: CloudflareDurableObjectServer,
  state: DurableObjectState,
): Promise<void> {
  const discovery = new DiscoveryService(app.get(ModulesContainer));
  const scanner = new MetadataScanner();
  const contextId = getDurableObjectContextId(state);

  const tokens = new Set(
    discovery
      .getControllers()
      .filter(controller =>
        hasTransportHandler(controller.metatype?.prototype, scanner, server),
      )
      .map(controller => controller.token),
  );

  app.registerRequestByContextId(contextId.payload, contextId);

  await Promise.all(
    [...tokens].map(token =>
      app.resolve(token, contextId, { strict: false, each: true }),
    ),
  );
}

function hasTransportHandler(
  prototype: object | undefined,
  scanner: MetadataScanner,
  server: CloudflareDurableObjectServer,
): boolean {
  if (!prototype) {
    return false;
  }

  return scanner.getAllMethodNames(prototype).some(name => {
    const method: unknown = Reflect.get(prototype, name);

    if (typeof method !== 'function') {
      return false;
    }

    const transport: unknown = Reflect.getMetadata(TRANSPORT_METADATA, method);

    return (
      Reflect.hasMetadata(PATTERN_METADATA, method) &&
      (transport === undefined || transport === server.transportId)
    );
  });
}
