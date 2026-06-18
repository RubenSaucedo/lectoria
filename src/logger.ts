/**
 * Minimal logger interface for library code.
 *
 * lectoria is a library first and a CLI second. Library code must not write
 * to stdout/stderr by itself — host applications (CLIs, services, plugins)
 * are the ones that decide how to surface progress, warnings, and errors.
 *
 * Default behaviour: no-op. The CLI installs a small concrete logger
 * (see `src/cli.ts`) that forwards to stderr so users still see
 * progress when running `lectoria run ...`.
 */
export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Logger that writes to a write stream (defaults to process.stderr).
 *
 * Exported as a convenience for callers that want CLI-style output without
 * pulling in a heavy logging library. Not used by lectoria itself.
 */
export function createStreamLogger(stream: NodeJS.WritableStream = process.stderr): Logger {
  const write = (level: string, msg: string) => {
    stream.write(`[lectoria:${level}] ${msg}\n`);
  };
  return {
    debug: (m) => write('debug', m),
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
  };
}
