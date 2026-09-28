import { slugify } from './src/lib/text';

// Loaded by path from the config: alive.
export function remarkPlugin(): string {
  return slugify('Intro');
}
