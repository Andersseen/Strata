import { defineEventHandler, getQuery } from "h3";

import { STREAM_CANARY, waitFor } from "../../strata/stream-barrier";

// A control for the Strata streaming checks: a native Nitro route that returns an
// ordinary Response over a ReadableStream, with no Strata code on the path. It shows what
// the installed transport does with a gated or failing body by itself.
export default defineEventHandler((event) => {
  const query = getQuery(event);
  const id = String(query["id"] ?? "native");
  const mode = String(query["mode"] ?? "gate");
  let step = 0;

  return new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const encoder = new TextEncoder();
          if (step === 0) {
            controller.enqueue(encoder.encode(`${id}:0;`));
          } else if (mode === "fail") {
            throw new Error(`native producer failed (${STREAM_CANARY})`);
          } else {
            await waitFor(id);
            controller.enqueue(encoder.encode(`${id}:1;`));
            controller.close();
          }
          step++;
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
});
