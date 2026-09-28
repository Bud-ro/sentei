export function listPosts(): string[] {
  return [postTitle('hello')];
}

function postTitle(s: string): string {
  return s.toUpperCase();
}
