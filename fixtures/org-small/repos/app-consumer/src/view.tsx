import { Widget } from '@acme/widgets';

// Expected: alive, no finding (module-exported but not package-exported; used by main.ts).
export const view: JSX.Element = <Widget label="x" />;
