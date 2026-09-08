// Submits the signed app to Apple for notarization, then staples the ticket so
// it verifies offline.
//
// Needs a stored notarytool credential, which only has to be set up once:
//
//   xcrun notarytool store-credentials basalt \
//     --apple-id "you@example.com" \
//     --team-id "<your 10-character team id>" \
//     --password "<app-specific password from appleid.apple.com>"
//
// Then:  npm run notarize        (or NOTARY_PROFILE=<name> npm run notarize)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP = path.join(ROOT, 'dist', 'Basalt-darwin-arm64', 'Basalt.app');
const ZIP = path.join(ROOT, 'dist', 'Basalt.zip');
const PROFILE = process.env.NOTARY_PROFILE || 'basalt';

const run = (file, args) => execFileSync(file, args, { stdio: 'inherit' });

if (!fs.existsSync(APP)) {
  console.error(`No packaged app at ${APP}. Run "npm run package" && "npm run sign" first.`);
  process.exit(1);
}

// Refuse to submit something unsigned: notarization would fail anyway, several
// minutes later.
try {
  execFileSync('codesign', ['--verify', '--strict', APP], { stdio: 'pipe' });
} catch (_) {
  console.error('The app is not validly signed. Run "npm run sign" first.');
  process.exit(1);
}

// Apple only notarizes Developer ID builds. The default local signing identity
// is an Apple Development certificate, so catch that here rather than after a
// long upload and a confusing rejection.
const details = execFileSync('codesign', ['--display', '--verbose=2', APP], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  + execFileSync('codesign', ['--display', '--verbose=4', APP], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
if (!details.includes('Developer ID Application')) {
  console.error(`This build is not signed with a Developer ID certificate, so Apple will not
notarize it. Re-sign first:

  BASALT_IDENTITY="Developer ID Application: Your Name (TEAMID)" npm run sign
`);
  process.exit(1);
}

// notarytool takes an archive, and ditto is the only zip that preserves the
// bundle's symlinks and extended attributes intact.
console.log('Archiving');
fs.rmSync(ZIP, { force: true });
run('ditto', ['-c', '-k', '--keepParent', APP, ZIP]);

console.log(`\nSubmitting to Apple (credential profile "${PROFILE}") — this usually takes a few minutes`);
try {
  run('xcrun', ['notarytool', 'submit', ZIP, '--keychain-profile', PROFILE, '--wait']);
} catch (_) {
  console.error(`\nSubmission failed. If the profile is missing, create it once with:

  xcrun notarytool store-credentials ${PROFILE} \\
    --apple-id "<your Apple ID>" \\
    --team-id "<your 10-character team id>" \\
    --password "<app-specific password>"
`);
  process.exit(1);
}

// Staple the ticket onto the bundle so Gatekeeper clears it without a network
// round trip.
console.log('\nStapling the ticket');
run('xcrun', ['stapler', 'staple', APP]);

console.log('\nVerifying the way Gatekeeper will');
run('xcrun', ['stapler', 'validate', APP]);
run('spctl', ['--assess', '--type', 'execute', '--verbose=4', APP]);

console.log('\nNotarized and stapled.');
