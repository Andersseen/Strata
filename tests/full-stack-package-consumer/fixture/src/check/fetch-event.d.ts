/** Minimal ambient shape required by H3's FetchEvent declaration in this Node consumer. */
interface FetchEvent {
  respondWith(response: Response | Promise<Response>): void;
}
