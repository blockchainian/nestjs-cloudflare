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

/** RPC stubs synthesize callable properties that are not declared methods. */
function hasBindingMethod(value: object, method: string): boolean {
  let target: object | null = value;

  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, method);

    if (descriptor) {
      return typeof descriptor.value === 'function';
    }

    target = Object.getPrototypeOf(target);
  }

  return false;
}
