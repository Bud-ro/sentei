// An Expo config plugin (compiled to plugin/build, which app.plugin.js requires).
type ExpoConfig = { name: string; plugins?: string[] };

export function withAcme(config: ExpoConfig): ExpoConfig {
  return { ...config, plugins: [...(config.plugins ?? []), 'acme'] };
}

export default withAcme;
