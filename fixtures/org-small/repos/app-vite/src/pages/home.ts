export function homePage(): string {
  return pageTitle('home');
}

function pageTitle(name: string): string {
  return `# ${name}`;
}
