// Started by `npm start` (`node scripts/serve.mjs`): a runtime entry outside the
// tsconfig program. sentei indexes it through its runtime tsconfig.
import { serveBanner } from '../src/banner.js';

console.log(serveBanner(8080));
