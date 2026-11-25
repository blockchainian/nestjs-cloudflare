import type { CloudflareDurableObjectRecordOptions } from './interfaces/client-options.interface.js';

/** Carries message data and per-call object addressing. */
export class CloudflareDurableObjectRecord<T = unknown> {
  constructor(
    public readonly data: T,
    public readonly options?: CloudflareDurableObjectRecordOptions,
  ) {}
}

/** Builds transport records using Nest's record builder convention. */
export class CloudflareDurableObjectRecordBuilder<T = unknown> {
  private options?: CloudflareDurableObjectRecordOptions;

  constructor(private data: T) {}

  public setData(data: T): this {
    this.data = data;

    return this;
  }

  public setOptions(options: CloudflareDurableObjectRecordOptions): this {
    this.options = options;

    return this;
  }

  public build(): CloudflareDurableObjectRecord<T> {
    return new CloudflareDurableObjectRecord(this.data, this.options);
  }
}
