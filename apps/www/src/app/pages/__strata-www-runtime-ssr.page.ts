// The landing, never prerendered: `pnpm test:www:server-components` requests this path to prove the
// runtime server graph renders the Server Component, not only the build-time one behind `/`.
export { default } from "./index.page";
