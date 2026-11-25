import { catchError, defer, EMPTY, mergeMap, Subject, tap } from 'rxjs';

interface PendingMessage {
  frame: string | ArrayBuffer;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** Applies a concurrency limit to one socket's asynchronous dispatch. */
export class WebSocketMessageDispatcher {
  private readonly pending = new Subject<PendingMessage>();
  private closed = false;

  constructor(
    handle: (frame: string | ArrayBuffer) => Promise<void>,
    concurrency: number,
  ) {
    this.pending
      .pipe(
        mergeMap(
          task =>
            defer(() =>
              this.closed ? Promise.resolve() : handle(task.frame),
            ).pipe(
              tap(() => task.resolve()),
              catchError((error: unknown) => {
                task.reject(error);

                return EMPTY;
              }),
            ),
          concurrency,
        ),
      )
      .subscribe();
  }

  public dispatch(frame: string | ArrayBuffer): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      this.pending.next({ frame, resolve, reject });
    });
  }

  public close(): void {
    this.closed = true;
    this.pending.complete();
  }
}
