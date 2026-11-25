declare module 'express' {
  interface Application {
    set(name: string, value: boolean): Application;
  }

  export default function express(): Application;
}
