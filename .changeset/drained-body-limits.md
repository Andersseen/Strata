---
"@strata-sc/analog": patch
---

Fix a keep-alive connection desynchronisation after an oversized validated body on Node.

When `readValidatedJson()` or `readValidatedForm()` rejected a body over the 1 MiB limit with
413 on a Node request (Nitro `node-server`, Analog dev), Strata stopped reading by leaving a
`for await` loop, which destroys the request message. When that happened before Node's HTTP
parser had completed the message, the connection fell out of step and the next request on the
same keep-alive connection failed with a bare `400 Bad Request` from Node. On Nitro node-server
this reproduced on every attempt; behind a proxy that reuses upstream connections, that next
request can belong to another client.

The reader now stops collecting at the limit and drains the rest of the body without buffering
it, as Node does for any body a handler never reads. The 413 response, its body and
`onRequestSettled` outcome are unchanged; memory stays bounded by the limit. Cloudflare Workers
(body attached by the runtime) are unaffected. No migration is required.
