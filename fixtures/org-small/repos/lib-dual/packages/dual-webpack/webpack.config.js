// webpack builds dist/main.js from the entry below; nothing imports src/app.js.
module.exports = {
  entry: './src/app.js',
  output: { filename: '[name].js' },
};
