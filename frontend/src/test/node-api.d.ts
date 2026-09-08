/**
 * Test-only ambient declarations. layout.test.tsx reads the stylesheet from
 * disk because vitest's `css: false` config makes `?raw` / `?inline` CSS
 * imports come back empty. The application itself never uses Node APIs;
 * these declarations exist purely so that one test type-checks under the
 * browser-oriented tsconfig without adding @types/node as a dependency.
 */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: string): string
}

declare module 'node:path' {
  export function resolve(...paths: string[]): string
}

declare var process: { cwd(): string }
