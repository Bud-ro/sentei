const { app, BrowserWindow } = require('electron');
const path = require('path');
const url = require('url');

// bluefireteam SpritesheetMapper (fix round 8e): the window's HTML is named by
// url.format({ pathname: path.join(__dirname, 'index.html') }) over several lines.
app.on('ready', () => {
  const win = new BrowserWindow({});
  win.loadURL(url.format({
    pathname: path.join(__dirname, 'index.html'),
    protocol: 'file:',
    slashes: true,
  }));
});
