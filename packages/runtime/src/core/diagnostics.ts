/**
 * Diagnostics: the one shape every error and warning takes, from the checker, the
 * transpiler and the runtime alike. Codes are stable and grouped:
 *
 *   PP1xxx project/manifest   PP2xxx references   PP3xxx runtime misuse
 *   PP4xxx schema/hooks       PP5xxx budgets      PP6xxx language/transpiler
 *   PP9xxx internal
 *
 * Every code has a docs page at `docsUrl(code)`.
 */

export const DOCS_BASE = 'https://parallaxpro.ai/docs/engine/errors/';

export type DiagnosticCode = `PP${number}`;
export type Severity = 'error' | 'warning';

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: Severity;
  readonly message: string;
  /** What to change, phrased as an instruction. */
  readonly fix?: string;
  /** Project-relative file the problem is in. */
  readonly path?: string;
  /** JSON pointer inside `path` (data files), e.g. `/entities/3/prefab`. */
  readonly pointer?: string;
  /** 1-based line inside `path` (code files). */
  readonly line?: number;
  readonly docs: string;
}

export interface DiagnosticInit {
  readonly severity?: Severity;
  readonly fix?: string;
  readonly path?: string;
  readonly pointer?: string;
  readonly line?: number;
}

export function docsUrl(code: DiagnosticCode): string {
  return `${DOCS_BASE}${code}`;
}

export function diagnostic(code: DiagnosticCode, message: string, init: DiagnosticInit = {}): Diagnostic {
  return {
    code,
    severity: init.severity ?? 'error',
    message,
    ...(init.fix !== undefined && { fix: init.fix }),
    ...(init.path !== undefined && { path: init.path }),
    ...(init.pointer !== undefined && { pointer: init.pointer }),
    ...(init.line !== undefined && { line: init.line }),
    docs: docsUrl(code),
  };
}

/** The human form: code and message, location, fix, docs link. */
export function formatDiagnostic(d: Diagnostic): string {
  const lines = [`${d.code}  ${d.message}`];
  if (d.path !== undefined) {
    const at = d.line !== undefined ? `${d.path}:${d.line}` : d.path;
    lines.push(d.pointer !== undefined ? `  at ${at}  (${d.pointer})` : `  at ${at}`);
  }
  if (d.fix !== undefined) lines.push(`  Fix: ${d.fix}`);
  lines.push(`  Docs: ${d.docs}`);
  return lines.join('\n');
}

/** An error carrying a diagnostic. Development builds throw these; release builds report and continue. */
export class ParallaxError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(d: Diagnostic) {
    super(formatDiagnostic(d));
    this.name = 'ParallaxError';
    this.diagnostic = d;
  }
}

export function fail(code: DiagnosticCode, message: string, init: DiagnosticInit = {}): never {
  throw new ParallaxError(diagnostic(code, message, init));
}
