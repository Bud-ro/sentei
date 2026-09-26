const { app, BrowserWindow } = require('electron');

app.on('ready', () => {
  const win = new BrowserWindow({ webPreferences: { nodeIntegration: true } });
  win.loadFile('index.html');
});
