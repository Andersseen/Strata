import { createRouteDecorator } from "./route-decorator.js";

/*
 * Each decorator marks a controller method as the handler for one HTTP method.
 *
 * They only record declarative metadata (method, path, handler name) — they do
 * not invoke the method and do not wire up any HTTP runtime.
 *
 * Supported members: public or protected instance methods with a string name.
 * Static, private (`#name`) and symbol-named methods throw a `TypeError` when
 * the class is defined. The route belongs to the class that declares it; a
 * subclass does not inherit it, even when it overrides the method.
 */

/** Marks a controller method as a GET route handler. */
export const Get = createRouteDecorator("GET", "Get");

/** Marks a controller method as a POST route handler. */
export const Post = createRouteDecorator("POST", "Post");

/** Marks a controller method as a PUT route handler. */
export const Put = createRouteDecorator("PUT", "Put");

/** Marks a controller method as a PATCH route handler. */
export const Patch = createRouteDecorator("PATCH", "Patch");

/** Marks a controller method as a DELETE route handler. */
export const Delete = createRouteDecorator("DELETE", "Delete");
