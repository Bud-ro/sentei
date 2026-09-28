// A Docusaurus site (fix round 8e): the config, sidebars, src/theme, src/pages and
// src/plugins are runtime entries by convention; so is every own file the config names
// with a relative path (require.resolve('./remark-plugin.ts')).
export default {
  presets: [['classic', { docs: { sidebarPath: './sidebars.ts', remarkPlugins: [require.resolve('./remark-plugin.ts')] } }]],
};
