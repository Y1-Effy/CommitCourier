/**
 * Ambient declaration for `*.sql` imports.
 *
 * The DDL is imported as a string and embedded into the bundle at build time (esbuild `text`
 * loader in tsup; a small transform plugin in vitest), so there is no runtime file I/O. This
 * declaration lets `import sql from "./*.sql"` type-check under `verbatimModuleSyntax` /
 * `moduleResolution: "Bundler"`.
 */
declare module "*.sql" {
  const content: string;
  export default content;
}
