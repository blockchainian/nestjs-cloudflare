/**
 * Identifies a frame that cannot be decoded as an application message.
 *
 * @publicApi
 */
export class InvalidWebSocketMessageException extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidWebSocketMessageException';
  }
}
