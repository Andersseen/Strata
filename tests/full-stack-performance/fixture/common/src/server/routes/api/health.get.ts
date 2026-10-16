import { defineEventHandler } from "h3";

// Present in every arm. Analog only leaves `/api/**` to Nitro's router when the application owns a
// `routes/api` directory; without one it injects a middleware that rewrites `/api/*` requests to
// the SSR catch-all (docs/research/full-stack-external-consumer.md). Keeping this identical native
// route in all four arms makes the Nitro setup equal instead of favouring any arm.
export default defineEventHandler(() => ({ ok: true }));
