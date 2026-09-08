// Installs a packaged Linux build for the current user — no root needed.
//
//   npm run package && npm run install-linux
//
// Everything lands under ~/.local, which every desktop environment searches:
//   ~/.local/share/basalt/            the unpacked app
//   ~/.local/share/applications/      the launcher entry
//   ~/.local/share/icons/hicolor/...  the icon, so the launcher and task bar
//                                     both find it by name

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

if (process.platform !== 'linux') {
  console.error(`This installs a Linux build; on ${process.platform} use "npm run install-app".`);
  process.exit(1);
}

const source = path.join(ROOT, 'dist', `Basalt-linux-${process.arch}`);
if (!fs.existsSync(source)) {
  console.error(`No packaged build at ${source}. Run "npm run package" first.`);
  process.exit(1);
}

const home = os.homedir();
const appDir = path.join(home, '.local', 'share', 'basalt');
const desktopDir = path.join(home, '.local', 'share', 'applications');
const iconDir = path.join(home, '.local', 'share', 'icons', 'hicolor', '512x512', 'apps');

console.log(`Installing to ${appDir}`);
fs.rmSync(appDir, { recursive: true, force: true });
fs.cpSync(source, appDir, { recursive: true });

// The launcher binary has to stay executable through the copy.
const binary = path.join(appDir, 'Basalt');
fs.chmodSync(binary, 0o755);

fs.mkdirSync(iconDir, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'build', 'icon.png'), path.join(iconDir, 'basalt.png'));

// Point the entry at where the app actually landed. Icon can be the bare theme
// name now that the PNG is installed into hicolor.
fs.mkdirSync(desktopDir, { recursive: true });
const entry = fs.readFileSync(path.join(ROOT, 'build', 'basalt.desktop'), 'utf8')
  .replace(/^Exec=.*$/m, `Exec=${binary} %U`)
  .replace(/^Icon=.*$/m, 'Icon=basalt');
fs.writeFileSync(path.join(desktopDir, 'basalt.desktop'), entry, 'utf8');

console.log(`Installed:
  app      ${binary}
  launcher ${path.join(desktopDir, 'basalt.desktop')}
  icon     ${path.join(iconDir, 'basalt.png')}

If it does not appear in the launcher straight away, refresh the caches:
  update-desktop-database ~/.local/share/applications
  gtk-update-icon-cache -f -t ~/.local/share/icons/hicolor`);
