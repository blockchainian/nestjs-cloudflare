export function getDurableObjectNamespace(
  value: unknown,
  name: string,
): DurableObjectNamespace {
  validateBinding(value, 'Durable Object namespace', name, [
    'idFromName',
    'idFromString',
    'get',
  ]);

  return value as DurableObjectNamespace;
}

export function getQueueBinding(value: unknown): Queue {
  validateBinding(value, 'Queue', 'queue', ['send', 'sendBatch']);

  return value as Queue;
}

function validateBinding(
  value: unknown,
  kind: string,
  name: string,
  methods: readonly string[],
): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    !methods.every(method => hasBindingMethod(value, method))
  ) {
    throw new Error(`Missing or invalid ${kind} binding: ${name}`);
  }
}

/**
 * Miniflare Node proxies expose callable methods without property descriptors.
 * RPC stubs can also pass this check; interface mismatches fail when called.
 */
function hasBindingMethod(value: object, method: string): boolean {
  return typeof Reflect.get(value, method) === 'function';
}
