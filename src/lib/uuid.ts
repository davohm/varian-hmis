import { uuidv7 } from "uuidv7";

/** Generate a time-ordered UUIDv7 primary key. */
export function newId(): string {
  return uuidv7();
}

/** Generate an idempotency key for a command. */
export function newIdempotencyKey(): string {
  return uuidv7();
}
