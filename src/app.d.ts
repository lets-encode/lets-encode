// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    // Static SPA: no server request context, so no App.Locals.
    interface Error {
      message: string;
      /** A sentence below the message, on the error page. */
      detail?: string;
    }
  }
  /** Build date for the footer, injected by Vite's define. */
  const __BUILD_DATE__: string;
}

export {};
