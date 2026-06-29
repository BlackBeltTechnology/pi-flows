/**
 * Faux-model test harness — thin re-export.
 *
 * The harness machinery now lives in the SHIPPED module
 * `extensions/flow-engine/testing.ts` (exposed publicly via the
 * `@blackbelt-technology/pi-flows/testing` subpath export). The in-repo suites
 * consume it through this re-export so the surface they exercise is identical
 * to the published one.
 */

export * from "../extensions/flow-engine/testing.js";
