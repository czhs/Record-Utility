// Renders build/icon.svg to build/icon.png and build/icon.icns using Electron's Chromium.
// Run with: npm run icon
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

app.dock?.hide();

app.whenReady().then(async () => {
  const dir = __dirname;
  const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, transparent: true, frame: false,
    useContentSize: true, webPreferences: { offscreen: true, zoomFactor: 1 },
  });
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const img = (await win.webContents.capturePage()).resize({ width: 1024, height: 1024 });
  fs.writeFileSync(path.join(dir, 'icon.png'), img.toPNG());

  const iconset = path.join(dir, 'icon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale;
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      fs.writeFileSync(path.join(iconset, name), img.resize({ width: px, height: px, quality: 'best' }).toPNG());
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(dir, 'icon.icns')]);
  fs.rmSync(iconset, { recursive: true, force: true });
  console.log('Wrote build/icon.png and build/icon.icns');
  app.quit();
});
