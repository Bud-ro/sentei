// Entry point of @acme/app-skew, pinned to an old @acme/widgets.
// removedFn existed in the pinned release but not at HEAD: expected version_skew
// (package_id npm:@acme/app-skew, symbol removedFn). Typecheck fails with TS2305 by design.
import { removedFn, internalUsed } from '@acme/widgets';

removedFn();
internalUsed();
