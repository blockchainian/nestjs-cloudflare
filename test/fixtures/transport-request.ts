import type { ReadPacket, WritePacket } from '@nestjs/microservices';

interface TransportHost {
  dispatch(packet: ReadPacket): Promise<WritePacket<unknown>[]>;
}

export function dispatch(
  host: TransportHost,
  id: string,
  pattern: string,
  data: unknown,
): Promise<WritePacket<unknown>[]> {
  const packet = { id, pattern, data };

  return host.dispatch(packet);
}
