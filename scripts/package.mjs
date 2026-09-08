// Builds the app bundle for a platform.
//
//   npm run package              # this machine's platform and architecture
//   npm run package -- --linux   # or name one explicitly
//   npm run package -- --mac --arch=x64
//
// The native module (node-pty) is compiled for the host, so a build is only
// valid on the platform it was made on — there is no cross-compiling here. To
// produce a Linux build, run this on Linux (a container is fine).

import { packager } from '@electron/packager';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);

// One source of truth for the version, so a release tag only has to change
// package.json rather than being repeated here.
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const platform = argv.includes('--linux') ? 'linux'
  : argv.includes('--mac') || argv.includes('--darwin') ? 'darwin'
    : argv.includes('--win') || argv.includes('--windows') ? 'win32'
      : process.platform;

const archArg = argv.find((a) => a.startsWith('--arch='));
const arch = archArg ? archArg.slice('--arch='.length) : process.arch;

if (platform !== process.platform) {
  console.error(`Refusing to build for ${platform} on ${process.platform}: node-pty is a native
module and is compiled for the host, so the result would not run. Build on the
target platform instead.`);
  process.exit(1);
}

// Same reasoning for the architecture: Electron would be downloaded for the
// target, but the node-pty binary next to it is whatever was compiled here.
if (arch !== process.arch) {
  console.error(`Refusing to build for ${arch} on ${process.arch}: the bundled node-pty is
compiled for this machine's architecture and would not load. Build on a
${arch} machine instead.`);
  process.exit(1);
}

// Everything that is not part of the running app: build inputs, tests, and the
// prebuilt binaries node-pty ships for other platforms. Those last ones are the
// bulk of it — roughly 60MB of Windows ConPTY that also breaks macOS signing.
const ignore = [
  '^/dist', '^/build', '^/test', '^/scripts', '^/icon\\.png', '^/\\.github',
  '^/node_modules/node-pty/third_party',
  '^/node_modules/node-pty/prebuilds',
  '^/node_modules/node-pty/build/Release/(obj\\.target|\\.deps)',
];

// The window icon is read from disk at run time everywhere except macOS, where
// it is compiled into the bundle instead — so it has to ship inside the app.
if (platform !== 'darwin') {
  ignore[1] = '^/build/(icon\\.iconset|icon\\.icns|entitlements\\.plist|basalt\\.desktop)';
}

// ConPTY is how node-pty drives a terminal on Windows: OpenConsole.exe and
// conpty.dll are launched at run time, so on that platform they are the one
// part of third_party that must ship. Everywhere else they are dead weight
// that also breaks macOS signing.
//
// The prebuilds stay excluded on Windows too — node-pty looks in build/Release
// first, and that is what the rebuild just produced — as do MSVC's build
// intermediates, which use a different directory name from the POSIX ones and
// were adding some 50MB to the archive.
if (platform === 'win32') {
  ignore.splice(ignore.indexOf('^/node_modules/node-pty/third_party'), 1);
  ignore.push('^/node_modules/node-pty/build/Release/obj/');
  ignore.push('^/node_modules/node-pty/build/.*\\.(pdb|ilk|exp|lib|recipe|tlog)$');
}

const options = {
  dir: ROOT,
  name: 'Basalt',
  platform,
  arch,
  out: path.join(ROOT, 'dist'),
  overwrite: true,
  appVersion: version,
  ignore: ignore.map((pattern) => new RegExp(pattern)),
};

if (platform === 'darwin') {
  options.icon = path.join(ROOT, 'build', 'icon.icns');
  options.appBundleId = 'dev.ethanw.basalt';
  options.appCategoryType = 'public.app-category.developer-tools';
} else if (platform === 'win32') {
  options.icon = path.join(ROOT, 'build', 'icon.ico');
  options.win32metadata = {
    CompanyName: 'Basalt',
    FileDescription: 'Basalt terminal',
    OriginalFilename: 'Basalt.exe',
    ProductName: 'Basalt',
    InternalName: 'Basalt',
  };
} else {
  options.icon = path.join(ROOT, 'build', 'icon.png');
}

const [output] = await packager(options);
console.log(`Wrote ${path.relative(ROOT, output)}`);
