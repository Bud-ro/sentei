// react-native-builder-bob layout (fix round 8e): lib/typescript/commonjs/src/index.d.ts maps
// back to this file; `./Button` exists only as Button.ios.ts / Button.android.ts (Metro
// picks one), so both are runtime entries.
// @ts-ignore: TypeScript resolves no plain ./Button
import { Button } from './Button';

export function renderButton(): string {
  return Button();
}
