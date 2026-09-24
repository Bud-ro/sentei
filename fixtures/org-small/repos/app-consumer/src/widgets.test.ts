// Test file (matches **/*.test.*): its references do not count as consumer refs,
// except into @acme/testkit, which this package declares only in devDependencies.
import { testOnlyFn } from '@acme/widgets';
import { renderHelper } from '@acme/testkit';

testOnlyFn();
renderHelper('Widget');
