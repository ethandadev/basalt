# Basalt

A terminal for macOS, Linux and Windows with visual completions, foldable
command output, easy shell switching, and built-in SSH and file transfer.

Built on [Electron](https://electronjs.org), [xterm.js](https://xtermjs.org) and
[node-pty](https://github.com/microsoft/node-pty).

## What it does

**Predicts as you type.** A greyed-out suggestion completes the rest of the line
from your shell history; `→` accepts it, `⌥→` takes one word. Tab opens a
completion menu over commands, files, and a few tools' sub-commands, falling
through to the shell's own completion when nothing matches.

**Folds command output.** Basalt installs OSC 133 marks into zsh, bash and
PowerShell, which lets it slice the scrollback into per-command blocks. Long
output shortens itself to a head, a tail and a summary line you can click to
expand. `⌘E` cycles the last block; the command list panel folds any of them.

**Switches shells per tab.** Every shell on the machine is offered in the
toolbar picker — change the shell in the current tab, or open a new one with it.

**Connects over SSH.** The `ssh` picker reads `~/.ssh/config`, including
multi-alias `Host` lines and `Include` globs, and opens a tab connected to the
host you pick. On macOS and Linux the connection is multiplexed, so a host that
asked for a password or a hardware key once is reachable afterwards without
asking again.

**Moves files.** The remote files panel browses a host, uploads, downloads,
creates folders and deletes. It shares the terminal's connection where the
platform allows it, and never handles a credential itself — every operation
runs through the `ssh` and `sftp` binaries already on the machine, so keys,
agents, jump hosts and per-host config all behave exactly as they do in a shell.

## Installing

Download a build from [Releases](../../releases):

| Download | Platform |
| --- | --- |
| `Basalt-darwin-arm64.zip` | macOS, Apple silicon |
| `Basalt-linux-x64.tar.gz` | Linux, x64 |
| `Basalt-win32-x64.zip` | Windows, x64 |

Release builds are **not code signed**. On macOS, clear the quarantine
attribute after moving the app into `/Applications`:

```bash
xattr -dr com.apple.quarantine /Applications/Basalt.app
```

On Windows, SmartScreen warns the first time — *More info* → *Run anyway*.

## Building from source

`node-pty` is a native module compiled against Electron for the host platform,
so a build only runs on the platform it was made on. There is no cross
compiling: build each target on that target.

```bash
npm install          # postinstall rebuilds node-pty for Electron
npm start            # run from source
npm test             # unit and platform tests
npm run test:e2e     # drives the real app over the DevTools protocol
npm run package      # build for this platform into dist/
```

On macOS `npm run install-app` packages, signs and copies to `/Applications`.
On Linux `npm run install-linux` installs under `~/.local` with a desktop entry.

### Signing (macOS)

Signing is opt-in and takes the certificate from the environment, so nothing
about a particular developer is baked into the repository:

```bash
security find-identity -v -p codesigning          # what you have
BASALT_IDENTITY="Developer ID Application: Your Name (TEAMID)" npm run sign
npm run notarize                                   # needs a notarytool profile
```

An *Apple Development* certificate produces a build that runs on your own Macs
but that other machines refuse and Apple will not notarize. A *Developer ID*
certificate is the distributable one.

## Shortcuts

macOS keeps these on ⌘, which the shell never sees. Linux and Windows put them
on `Ctrl+Shift` and `Ctrl+Alt`, because there `Ctrl+C` has to reach the
foreground process as an interrupt rather than copying a selection.

| | macOS | Linux / Windows |
| --- | --- | --- |
| New tab | `⌘T` | `Ctrl+Shift+T` |
| Close tab | `⌘W` | `Ctrl+Shift+W` |
| Go to tab | `⌘1`…`⌘9` | `Alt+1`…`Alt+9` |
| Copy / paste | `⌘C` / `⌘V` | `Ctrl+Shift+C` / `Ctrl+Shift+V` |
| Find | `⌘F` | `Ctrl+Shift+F` |
| Cycle fold on last output | `⌘E` | `Ctrl+Shift+E` |
| Command list | `⌘⇧O` | `Ctrl+Shift+O` |
| Connect over SSH | `⌘⇧K` | `Ctrl+Alt+K` |
| Remote files | `⌘⇧B` | `Ctrl+Shift+B` |
| Settings | `⌘,` | `Ctrl+,` |
| Keyboard shortcuts | `⌘/` | `F1` |

The in-app shortcut sheet renders from the same table the menus are built from,
so it always shows the bindings actually in force.

## Shell integration

Basalt writes its integration scripts into its own data directory on every
launch and points the shell at them — your dotfiles are never modified. zsh gets
a `ZDOTDIR` that forwards to your real startup files; bash gets an `--rcfile`
wrapper that sources your profile first; PowerShell dot-sources after `$PROFILE`
has loaded and wraps whatever prompt you already had.

Shells without integration (fish, cmd.exe, nushell, WSL) still run normally —
they just have no block folding, and prediction comes from history alone.

## License

MIT — see [LICENSE](LICENSE).
