#!/usr/bin/env python3
"""Runs a real zsh and bash under a pty with Basalt's shell integration loaded,
and checks that the semantic marks folding depends on actually come out.

Node generates the integration directory (using the app's own code path), then
this drives the shell the way the terminal would.
"""

import os
import pty
import re
import select
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

failures = 0
passed = 0


def report(name, ok, detail=""):
    global failures, passed
    if ok:
        passed += 1
        print(f"  ok  {name}")
    else:
        failures += 1
        print(f"  FAIL  {name}\n        {detail}")


def generate_integration(base):
    """Ask shells.js to write its integration files into `base`."""
    script = (
        "const s=require('%s/src/main/shells.js');"
        "console.log(s.integrationRoot(process.argv[1]));"
        "console.log(JSON.stringify(s.launchPlan(process.argv[2],{login:true})));"
    ) % ROOT
    out = subprocess.run(
        ["node", "-e", script, base, "/bin/zsh"],
        capture_output=True, text=True, check=True,
    ).stdout.strip().split("\n")
    return out[0]


def run_shell(argv, env, commands, timeout=12, warmup=0.6, gap=0.6):
    """Drive a shell in a pty and return everything it wrote."""
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.clear()
        os.environ.update(env)
        os.execv(argv[0], argv)

    output = bytearray()
    pending = list(commands)
    deadline = timeout

    # Give the shell a moment to draw its first prompt before typing.
    import time
    start = time.time()
    next_send = start + warmup

    while time.time() - start < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            output += chunk
        if pending and time.time() >= next_send:
            os.write(fd, pending.pop(0).encode())
            next_send = time.time() + gap
        if not pending and b"\x1b]133;D" in output and output.count(b"\x1b]133;D") >= len(commands) - 1:
            # Everything we asked for has finished; drain briefly and stop.
            if time.time() - start > 1.5:
                break

    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass
    return bytes(output)


def check_shell(label, shell_path, integration_dir, home):
    plan_script = (
        "const s=require('%s/src/main/shells.js');"
        "s.integrationRoot(process.argv[2]);"
        "console.log(JSON.stringify(s.launchPlan(process.argv[1],{login:true})));"
    ) % ROOT
    plan = subprocess.run(
        ["node", "-e", plan_script, shell_path, os.path.dirname(integration_dir)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()

    import json
    plan = json.loads(plan)

    env = {
        "HOME": home,
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "TERM": "xterm-256color",
        "LANG": "en_US.UTF-8",
    }
    env.update(plan["env"])

    out = run_shell([plan["file"]] + plan["args"], env,
                    ["echo hello-from-basalt\n", "false\n", "exit\n"])

    report(f"{label}: emits a prompt mark (OSC 133;A)", b"\x1b]133;A\x07" in out)
    report(f"{label}: emits a command-start mark (OSC 133;C)", b"\x1b]133;C\x07" in out)

    finished = re.findall(rb"\x1b\]133;D;(\d+)\x07", out)
    report(f"{label}: emits command-finished marks with a status",
           len(finished) >= 2, f"found {finished!r}")
    report(f"{label}: reports the failing exit status of `false`",
           b"1" in finished, f"statuses seen: {finished!r}")

    report(f"{label}: reports the working directory",
           b"\x1b]1337;CurrentDir=" in out)
    report(f"{label}: advertises its aliases and functions once",
           out.count(b"\x1b]1337;BasaltCmds=") == 1,
           f"seen {out.count(b'\x1b]1337;BasaltCmds=')} times")
    report(f"{label}: the command still actually ran",
           b"hello-from-basalt" in out)


def check_powershell(integration_dir, home):
    """PowerShell is the third integrated shell, and it runs on every platform,
    so its script can be exercised here rather than only on Windows."""
    pwsh = None
    for candidate in ("/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh", "/usr/bin/pwsh"):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            pwsh = candidate
            break
    if not pwsh:
        print("  --  PowerShell not installed here, skipping its checks")
        return

    import json
    plan = json.loads(subprocess.run(
        ["node", "-e",
         ("const s=require('%s/src/main/shells.js');"
          "s.integrationRoot(process.argv[2]);"
          "console.log(JSON.stringify(s.launchPlan(process.argv[1],{login:true})));") % ROOT,
         pwsh, os.path.dirname(integration_dir)],
        capture_output=True, text=True, check=True).stdout.strip())

    report("pwsh: is launched with the integration dot-sourced",
           "-NoExit" in plan["args"] and any("basalt.ps1" in a for a in plan["args"]),
           " ".join(plan["args"]))
    report("pwsh: counts as an integrated shell", plan["integrated"] is True)

    env = {
        "HOME": home,
        "PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "TERM": "xterm-256color",
        "LANG": "en_US.UTF-8",
    }
    env.update(plan["env"])

    # PSReadLine binds Enter to carriage return, not newline: sending "\n" only
    # edits the line and never submits it, which looks like a working shell
    # because the typed text still echoes back.
    #
    # The command is chosen so its output cannot be confused with its echo —
    # "42" appears only if PowerShell actually evaluated it.
    # The failing command goes first so its status is definitely observed before
    # `exit` ends the session. PowerShell needs a longer gap than a POSIX shell
    # to run a command and redraw its prompt.
    out = run_shell([plan["file"]] + plan["args"], env,
                    ["& /usr/bin/false\r", "Write-Host (6*7)\r", "exit\r"],
                    timeout=45, warmup=3.5, gap=2.5)

    report("pwsh: emits a prompt mark (OSC 133;A)", b"\x1b]133;A\x07" in out,
           f"tail: {out[-200:]!r}")
    report("pwsh: emits a command-start mark (OSC 133;C)", b"\x1b]133;C\x07" in out,
           f"tail: {out[-200:]!r}")

    finished = re.findall(rb"\x1b\]133;D;(\d+)\x07", out)
    report("pwsh: emits command-finished marks with a status", len(finished) >= 1,
           f"found {finished!r}")
    report("pwsh: reports the failing exit status of a native command",
           b"1" in finished, f"statuses seen: {finished!r}")
    report("pwsh: reports the working directory", b"\x1b]1337;CurrentDir=" in out,
           f"tail: {out[-200:]!r}")
    report("pwsh: advertises its commands once",
           out.count(b"\x1b]1337;BasaltCmds=") == 1,
           f"seen {out.count(b'\x1b]1337;BasaltCmds=')} times")
    report("pwsh: the command was actually evaluated, not just echoed",
           b"42" in out, f"tail: {out[-300:]!r}")
    report("pwsh: the shell still shows a usable prompt",
           b"PS " in out or b"\x1b]133;A" in out)


def check_rc_is_sourced(integration_dir, home):
    """The user's own startup file must still run."""
    with open(os.path.join(home, ".zshrc"), "w") as handle:
        handle.write("export MY_OWN_RC_RAN=yes\n")

    import json
    plan = json.loads(subprocess.run(
        ["node", "-e",
         ("const s=require('%s/src/main/shells.js');"
          "s.integrationRoot(process.argv[2]);"
          "console.log(JSON.stringify(s.launchPlan('/bin/zsh',{login:true})));") % ROOT,
         "", os.path.dirname(integration_dir)],
        capture_output=True, text=True, check=True).stdout.strip())

    env = {"HOME": home, "PATH": "/usr/bin:/bin", "TERM": "xterm-256color"}
    env.update(plan["env"])
    env["BASALT_ORIG_ZDOTDIR"] = home

    out = run_shell([plan["file"]] + plan["args"], env,
                    ["echo rc=$MY_OWN_RC_RAN\n", "echo zdotdir=[$ZDOTDIR]\n", "exit\n"])

    report("zsh: still sources the user's own .zshrc", b"rc=yes" in out,
           f"output tail: {out[-300:]!r}")
    report("zsh: hands ZDOTDIR back to the user's value",
           b"zdotdir=[]" in out or f"zdotdir=[{home}]".encode() in out,
           f"output tail: {out[-300:]!r}")


def main():
    with tempfile.TemporaryDirectory() as base:
        home = os.path.join(base, "home")
        os.makedirs(home)
        integration_dir = generate_integration(base)

        for name in [".zshrc", ".zshenv", ".zprofile", ".zlogin", "basalt.zsh",
                     "basalt.bash", "basalt-bashrc", "basalt.ps1"]:
            report(f"generated {name}", os.path.isfile(os.path.join(integration_dir, name)))

        check_shell("zsh", "/bin/zsh", integration_dir, home)
        check_shell("bash", "/bin/bash", integration_dir, home)
        check_powershell(integration_dir, home)
        check_rc_is_sourced(integration_dir, home)

    print(f"\n{passed} checks passed, {failures} failed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
