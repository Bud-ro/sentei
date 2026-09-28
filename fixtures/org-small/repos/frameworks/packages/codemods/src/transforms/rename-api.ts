import { renameIdentifier } from '../utils';

// A jscodeshift transform (fix round 8e): run by path (`jscodeshift -t`), a runtime
// entry; jscodeshift also reads its `parser` export by name.
export default function transform(file: { source: string }, api: unknown): string {
  return renameIdentifier(file.source, api);
}

export const parser = 'tsx';
