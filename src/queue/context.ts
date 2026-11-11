import { BaseRpcContext } from '@nestjs/microservices';

type WorkerExecutionContext = ExecutionContext;

type CloudflareQueueContextArgs = [
  Message,
  MessageBatch,
  WorkerExecutionContext,
  string,
];

/**
 * Exposes the native Queue event and matched Nest pattern to a handler.
 *
 * @publicApi
 */
export class CloudflareQueueContext extends BaseRpcContext<CloudflareQueueContextArgs> {
  constructor(args: CloudflareQueueContextArgs) {
    super(args);
  }

  /** Returns the message, including acknowledgement and retry methods. */
  public getMessage(): Message {
    return this.args[0];
  }

  /** Returns the batch containing this message. */
  public getBatch(): MessageBatch {
    return this.args[1];
  }

  /** Returns the Worker execution context for background work. */
  public getExecutionContext(): WorkerExecutionContext {
    return this.args[2];
  }

  /** Returns the normalized Nest event pattern. */
  public getPattern(): string {
    return this.args[3];
  }
}
