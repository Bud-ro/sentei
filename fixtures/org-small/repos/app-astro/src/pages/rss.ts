import { feedItems } from '../lib/feed';

// An Astro endpoint: loaded by the file router (a convention load of astro.config.mjs).
export function GET(): number {
  return feedItems().length;
}
