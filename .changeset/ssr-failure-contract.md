---
"@strata-sc/server-components": minor
---

Add the opt-in `@strata-sc/server-components/ssr` entry: a buffered SSR failure contract. `provideStrataSsrFailureHandler(RESPONSE)` (server application config) and `withStrataSsrFailureContract(render)` (`main.server.ts`) turn an unexpected render failure, or a rejected render, into HTTP 500 with `cache-control: no-store` and a static, hydration-free document before the response is written; headers the failed render set are dropped and one redacted line (class names only) is logged per failed request. Healthy renders, application-set statuses (a 404 page) and errors the application handles itself are unchanged. The entry imports only `@angular/core`, adds no peer dependency and is never in the browser graph; an application that does not import it renders exactly as before. Streaming SSR and already-committed responses are not covered. Experimental; additive, no migration needed.
