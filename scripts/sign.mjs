// Signs the packaged app.
//
// Electron bundles have to be signed inside-out — the framework and each helper
// app first, then the outer bundle — and the helpers need entitlements of their
// own. `codesign --deep` gets that wrong often enough that Apple discourages it,
// so this defers to @electron/osx-sign, which knows the layout.
//
//   BASALT_IDENTITY="Apple Development: you (TEAMID)" npm run sign
//
// An Apple Development certificate produces a build that runs on your own Macs
// but that other machines will refuse and that cannot be notarized. For
// something distributable, use the Developer ID certificate instead:
//
//   BASALT_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
//     npm run sign && npm run notarize
//
// `security find-identity -v -p codesigning` lists what is available.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signAsync } from '@electron/osx-sign';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP = path.join(ROOT, 'dist', 'Basalt-darwin-arm64', 'Basalt.app');
// Deliberately not defaulted: which certificate to sign with is a decision, and
// guessing it would quietly produce a build that cannot be distributed.
const IDENTITY = process.env.BASALT_IDENTITY;

if (!IDENTITY) {
  console.error(`Set BASALT_IDENTITY to the certificate to sign with, for example:

  BASALT_IDENTITY="Developer ID Application: Your Name (TEAMID)" npm run sign

The certificates on this machine:`);
  try {
    execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { stdio: 'inherit' });
  } catch (_) { /* nothing to list */ }
  process.exit(1);
}

if (!fs.existsSync(APP)) {
  console.error(`No packaged app at ${APP}. Run "npm run package" first.`);
  process.exit(1);
}

console.log(`Signing ${path.relative(ROOT, APP)}`);
console.log(`  identity: ${IDENTITY}`);

await signAsync({
  app: APP,
  identity: IDENTITY,
  platform: 'darwin',
  optionsForFile: () => ({
    // The hardened runtime is required for notarization, and it is what makes
    // these entitlements necessary in the first place.
    hardenedRuntime: true,
    entitlements: path.join(ROOT, 'build', 'entitlements.plist'),
    // Leaving `timestamp` unset makes osx-sign pass a bare --timestamp, which
    // uses Apple's server. Setting it to anything non-string is read as a URL.
  }),
});

// Verify the way Gatekeeper will, rather than trusting that signing reported
// success: --strict catches a nested bundle that was signed wrong.
console.log('\nVerifying signature');
execFileSync('codesign', ['--verify', '--strict', '--deep', '--verbose=2', APP], { stdio: 'inherit' });
execFileSync('codesign', ['--display', '--verbose=4', APP], { stdio: 'inherit' });

console.log('\nSigned and verified.');
