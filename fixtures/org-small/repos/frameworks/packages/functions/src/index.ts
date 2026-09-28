// Firebase Functions (fix round 8e): firebase.json names this package as the functions
// source, so its main's exports, re-exported ones included, are deployed functions.
export { onSignup } from './auth';

export function ping(): string {
  return 'pong';
}
