/**
 * CLI composition entry — re-exports the shared composition core
 * (src/lib/pipeline/compose.ts) so the CLI and the app compose identical pixels.
 */
export { composeView, type ComposeInput } from '../src/lib/pipeline/compose';
