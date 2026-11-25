import { BaseRpcContext } from '@nestjs/microservices';

type ContextArgs<Env> = [DurableObjectState, Env, string];

/** Exposes the native object event and matched Nest pattern. */
export class CloudflareDurableObjectContext<
  Env = Cloudflare.Env,
> extends BaseRpcContext<ContextArgs<Env>> {
  public getState(): DurableObjectState {
    return this.args[0];
  }

  public getEnv(): Env {
    return this.args[1];
  }

  public getPattern(): string {
    return this.args[2];
  }
}
