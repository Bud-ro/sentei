// Consumer of @acme/dup: two org packages have that name; discover resolves the dep to
// the only non-private one (repo `one`, resolution "published").
import { onlyInOne, shared } from '@acme/dup';

console.log(onlyInOne(), shared());
