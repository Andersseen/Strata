// Analog's generated server-function dispatch module imports `zone.js/node` and
// `@angular/platform-server/init`'s zone expectations even in a zoneless app.
// `zone.js` is not a dependency of this fixture, and the Cloudflare preset
// cannot leave a bare import external, so that one build aliases it here.
export {};
