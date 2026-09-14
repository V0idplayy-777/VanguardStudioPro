/**
 * Minimal ambient declarations for the Node globals the test runners use.
 *
 * The app itself is browser-only and deliberately does not pull in @types/node,
 * so the DOM typings stay authoritative for src/. Tests run under `node`, which
 * needs just this much of the process object.
 */
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
  exit(code?: number): never;
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
};
