const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const path = require('node:path');

const host = readFileSync(path.join(__dirname, 'host.ts'), 'utf8');
function wrapper(tailscale) {
  // Exercise the actual shell template without loading the host entry or
  // invoking enable/handoff against a live LaunchAgent.
  const start = host.indexOf('function wrapperScript(');
  const end = host.indexOf('\nfunction launchAgentPlist', start);
  assert.ok(start >= 0 && end > start);
  const source = host.slice(start, end).replace(
    'function wrapperScript(npx: string, tailscale: string | null): string',
    'function wrapperScript(npx, tailscale)',
  );
  return vm.runInNewContext(`${source}\nwrapperScript('/test/node/npx', tailscale)`, {
    paths: () => ({ home: '/test/home' }),
    path, tailscale, PORT: 38886, SYSTEM_PATH: '/usr/bin:/bin',
    shellQuote: value => `'${value.replaceAll("'", `'\\''`)}'`,
    releaseGuardShell: () => 'bb_is_running() { return 1; }',
  });
}

test('login wrappers cannot read credentials or start a Keychain dialog', () => {
  for (const tailscale of [null, '/test/tailscale']) {
    const script = wrapper(tailscale);
    assert.doesNotMatch(script, /find-generic-password|\/usr\/bin\/security|keychain-status/);
    assert.match(script, /exec "\$npx_path" --yes bb-app@latest start/);
    const syntax = spawnSync('/bin/zsh', ['-n'], { input: script, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});

test('enable and status do not launch any credential probes', () => {
  assert.doesNotMatch(host, /find-generic-password|\/usr\/bin\/security|probeKeychain|commandExitCode/);
  assert.match(host, /keychain: \{ credentialPresent: null, accessible: null,/);
  assert.doesNotMatch(host, /readFile\(.*keychainStatus|await keychainStatus/);
});

test('unknown auth does not block recovery-agent startup or claim auth success', () => {
  const handoff = host.slice(host.indexOf('async function scheduleHandoff('));
  assert.doesNotMatch(handoff, /current\.keychain/);
  for (const file of ['server.ts', 'app.tsx']) {
    const source = readFileSync(path.join(__dirname, file), 'utf8');
    assert.match(source, /credentialPresent === null \? "[Nn]ot checked"/);
  }
});
