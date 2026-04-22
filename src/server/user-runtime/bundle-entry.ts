// @ts-nocheck
// This file is the esbuild entry for scripts/build-teenybase-bundle.mjs, not
// something tsc should check. Re-exporting from teenybase's source directly
// pulls its strict-mode errors into our type-check; the ambient declaration
// in ./teenybase_bundle.d.ts is what the rest of the POC's TS actually sees.
//
// POC-owned bundle entry. Re-exports teenybase's cf-ui bundle surface +
// additional helpers user code needs (hono/html, hono/cookie) so user.js can
// do server-side rendering + set auth cookies without us having to touch
// teenybase's source (memory rule: no core edits from dependent packages).
//
// build-teenybase-bundle.mjs points at this file. esbuild --bundle pulls in
// teenybase transitively, so everything ends up in one ESM string file the
// dynamic worker imports as "./teenybase.js".

// Full teenybase cf-ui surface (migration raw APIs, $Database, teenyHono, etc.)
export * from "../../../../teenybase/src/bundle/cf-ui-entry"

// Scaffold field helpers — re-exported so user teenybase.ts configs can do
// `import { baseFields, authFields } from "teenybase"` (without the subpath).
// Matches the ergonomics users expect when pasting from notes-sample.
export {
  baseFields,
  authFields,
  createdTrigger,
  updatedTrigger,
  fields as scaffoldFields,
  triggers as scaffoldTriggers,
  TABLE_REF_TOKEN,
} from "../../../../teenybase/src/scaffolds/fields"

// hono/html — string-tagged template engine for SSR. Dynamic workers can't
// run JSX through LOADER.load (no TS/TSX transform), so user.js uses html`…`
// instead of <JSX>.
export { html, raw } from "hono/html"

// hono/cookie — set/delete the teenybase auth cookie after login/logout.
export { setCookie, deleteCookie, getCookie } from "hono/cookie"
