import { refreshToken } from '../auth';

const handlers: Array<() => string> = [];

export function fetchUser(): string {
  return handlers.map((h) => h()).join(',');
}

// Module-level code runs when the module is loaded: refreshToken is alive although no
// declaration of this module references it (drizzle-team 3310snake src/api/instance.ts).
handlers.push(refreshToken);
