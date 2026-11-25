/** Carries a Queue payload and native send options through Nest emit().
 * @publicApi
 */
export class CloudflareQueueRecord<TData = unknown> {
  constructor(
    public readonly data: TData,
    public readonly options?: QueueSendOptions,
  ) {}
}

/** Builds a Queue record using Nest's transport record convention.
 * @publicApi
 */
export class CloudflareQueueRecordBuilder<TData = unknown> {
  private options?: QueueSendOptions;

  constructor(private data?: TData) {}

  public setData(data: TData): this {
    this.data = data;

    return this;
  }

  public setOptions(options: QueueSendOptions): this {
    this.options = options;

    return this;
  }

  public build(): CloudflareQueueRecord<TData | undefined> {
    return new CloudflareQueueRecord(this.data, this.options);
  }
}
