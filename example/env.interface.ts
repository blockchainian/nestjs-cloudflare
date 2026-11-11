export interface Env {
  STATE: KVNamespace;
  NOTIFICATIONS: Queue<string>;
  GREETER: DurableObjectNamespace;
  CRON_SCHEDULE: string;
}
