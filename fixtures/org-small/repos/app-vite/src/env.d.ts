interface ImportMeta {
  glob(pattern: string | string[], options?: { eager?: boolean }): Record<string, unknown>;
}
