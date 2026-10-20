/**
 * Entry shim for the Harness loader.
 *
 * The loader resolves a bundle's `index.js` at the package root when it
 * activates the entry, while the TypeScript sources compile into `lib/`. This
 * file keeps both contracts true: it is the package entry, and it forwards
 * everything the compiled Host half exports.
 */
export * from './lib/index.js';