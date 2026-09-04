/**
 * E2E integration tests for plugin management commands.
 * Uses a temporary Git repository to verify the full install → list → update →
 * uninstall lifecycle without depending on GitHub or the npm registry.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import { runCli, parseJsonOutput } from './helpers.js';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-plugin-e2e-'));
const OPENCLI_HOME = path.join(TEST_HOME, '.opencli');
const PLUGINS_DIR = path.join(OPENCLI_HOME, 'plugins');
const PLUGIN_SOURCE = 'github:opencli-e2e/opencli-plugin-lifecycle-fixture';
const PLUGIN_URL = 'https://github.com/opencli-e2e/opencli-plugin-lifecycle-fixture.git';
const PLUGIN_NAME = 'lifecycle-fixture';
const PLUGIN_DIR = path.join(PLUGINS_DIR, PLUGIN_NAME);
const LOCK_FILE = path.join(OPENCLI_HOME, 'plugins.lock.json');
const FIXTURE_REPO = path.join(TEST_HOME, 'fixture-repo');
const GIT_CONFIG = path.join(TEST_HOME, 'gitconfig');
const TEST_ENV = {
  // Disable background update checks when running outside GitHub Actions too.
  CI: 'true',
  HOME: TEST_HOME,
  USERPROFILE: TEST_HOME,
  GIT_CONFIG_GLOBAL: GIT_CONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '0',
  // A missing URL rewrite must fail locally, never fall back to GitHub.
  GIT_ALLOW_PROTOCOL: 'file',
  npm_config_cache: path.join(TEST_HOME, 'npm-cache'),
  npm_config_userconfig: path.join(TEST_HOME, 'npmrc'),
  npm_config_offline: 'true',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_package_lock: 'true',
};
let initialCommit: string;

function fixtureGit(args: string[]): string {
  return execFileSync('git', args, {
    cwd: FIXTURE_REPO,
    env: { ...process.env, ...TEST_ENV },
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function commitFixtureVersion(version: string): string {
  fs.writeFileSync(path.join(FIXTURE_REPO, 'package.json'), JSON.stringify({
    name: `opencli-plugin-${PLUGIN_NAME}`,
    version,
    private: true,
    type: 'module',
    dependencies: {},
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(FIXTURE_REPO, 'opencli-plugin.json'), JSON.stringify({
    name: PLUGIN_NAME,
    version,
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(FIXTURE_REPO, 'hello.js'), `
import { cli, Strategy } from '@jackwener/opencli/registry';

cli({
  site: '${PLUGIN_NAME}',
  name: 'hello',
  description: 'Local plugin lifecycle fixture',
  strategy: Strategy.PUBLIC,
  browser: false,
  access: 'read',
  columns: ['version'],
  func: async () => [{ version: '${version}' }],
});
`);
  fixtureGit(['add', 'package.json', 'opencli-plugin.json', 'hello.js']);
  fixtureGit([
    '-c', 'user.name=OpenCLI E2E',
    '-c', 'user.email=opencli-e2e@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '-m', `Fixture ${version}`,
  ]);
  return fixtureGit(['rev-parse', 'HEAD']);
}

async function expectInstalledVersion(version: string, commit: string): Promise<void> {
  expect(fs.readFileSync(path.join(PLUGIN_DIR, 'hello.js'), 'utf-8'))
    .toBe(fs.readFileSync(path.join(FIXTURE_REPO, 'hello.js'), 'utf-8'));
  expect(fixtureGit(['-C', PLUGIN_DIR, 'rev-parse', 'HEAD'])).toBe(commit);
  // The fixture has no lockfile: this proves the real npm install ran.
  const packageLock = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package-lock.json'), 'utf-8'));
  expect(packageLock.packages[''].version).toBe(version);
  const { stdout, stderr, code } = await runPluginCli([PLUGIN_NAME, 'hello', '-f', 'json']);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
  expect(parseJsonOutput(stdout)).toEqual([{ version }]);
}

function runPluginCli(
  args: string[],
  opts: { timeout?: number; env?: Record<string, string> } = {},
) {
  return runCli(args, {
    ...opts,
    env: {
      ...TEST_ENV,
      ...opts.env,
    },
  });
}

describe('plugin management E2E', () => {
  beforeAll(() => {
    fs.mkdirSync(FIXTURE_REPO);
    fs.writeFileSync(TEST_ENV.npm_config_userconfig, '');
    fixtureGit(['init', '--initial-branch=main']);
    // Keep the github: source parser and real git clone path under test.
    fixtureGit([
      'config', '--file', GIT_CONFIG,
      `url.${pathToFileURL(FIXTURE_REPO).href}.insteadOf`, PLUGIN_URL,
    ]);
    initialCommit = commitFixtureVersion('1.0.0');
  });

  afterAll(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  // ── plugin list (empty) ──
  it('plugin list shows "No plugins installed" when none exist', async () => {
    const { stdout, code } = await runPluginCli(['plugin', 'list']);
    expect(code).toBe(0);
    expect(stdout).toContain('No plugins installed');
  });

  // ── plugin install ──
  it('plugin install clones and sets up a Git plugin', async () => {
    const { stdout, stderr, code } = await runPluginCli(['plugin', 'install', PLUGIN_SOURCE], {
      timeout: 50_000,
    });
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain('installed successfully');
    expect(stdout).toContain(PLUGIN_NAME);

    // Verify the plugin directory was created
    expect(fs.existsSync(PLUGIN_DIR)).toBe(true);

    // Verify lock file was updated
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
    expect(lock[PLUGIN_NAME]).toBeDefined();
    expect(lock[PLUGIN_NAME].commitHash).toBe(initialCommit);
    expect(lock[PLUGIN_NAME].source).toMatchObject({
      kind: 'git',
    });
    expect(lock[PLUGIN_NAME].source.url).toBe(PLUGIN_URL);
    expect(lock[PLUGIN_NAME].installedAt).toBeTruthy();
    await expectInstalledVersion('1.0.0', initialCommit);
  }, 60_000);

  // ── plugin list (after install) ──
  it('plugin list shows the installed plugin', async () => {
    const { stdout, code } = await runPluginCli(['plugin', 'list']);
    expect(code).toBe(0);
    expect(stdout).toContain(PLUGIN_NAME);
  });

  it('plugin list -f json returns structured data', async () => {
    const { stdout, code } = await runPluginCli(['plugin', 'list', '-f', 'json']);
    expect(code).toBe(0);
    const data = parseJsonOutput(stdout);
    expect(Array.isArray(data)).toBe(true);

    const plugin = data.find((p: any) => p.name === PLUGIN_NAME);
    expect(plugin).toBeDefined();
    expect(plugin.name).toBe(PLUGIN_NAME);
    expect(Array.isArray(plugin.commands)).toBe(true);
    expect(plugin.commands).toContain('hello');
    expect(plugin.version).toBe('1.0.0');
  });

  // ── plugin update ──
  it('plugin update installs a new commit and its contents', async () => {
    const updatedCommit = commitFixtureVersion('1.1.0');
    expect(updatedCommit).not.toBe(initialCommit);
    const { stdout, stderr, code } = await runPluginCli(['plugin', 'update', PLUGIN_NAME], {
      timeout: 25_000,
    });
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain('updated successfully');

    // Verify lock file has updatedAt
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
    expect(lock[PLUGIN_NAME].updatedAt).toBeTruthy();
    expect(lock[PLUGIN_NAME].commitHash).toBe(updatedCommit);
    await expectInstalledVersion('1.1.0', updatedCommit);
  }, 30_000);

  // ── plugin uninstall ──
  it('plugin uninstall removes the plugin', async () => {
    const { stdout, code } = await runPluginCli(['plugin', 'uninstall', PLUGIN_NAME]);
    expect(code).toBe(0);
    expect(stdout).toContain('uninstalled');

    // Verify directory was removed
    expect(fs.existsSync(PLUGIN_DIR)).toBe(false);

    // Verify lock entry was removed
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
    expect(lock[PLUGIN_NAME]).toBeUndefined();
  });

  // ── error paths ──
  it('plugin install rejects invalid source', async () => {
    const { stderr, code } = await runPluginCli(['plugin', 'install', 'invalid-source-format']);
    expect(code).toBe(1);
    expect(stderr).toContain('Invalid plugin source');
  });

  it('plugin uninstall rejects non-existent plugin', async () => {
    const { stderr, code } = await runPluginCli(['plugin', 'uninstall', '__nonexistent_plugin_xyz__']);
    expect(code).toBe(1);
    expect(stderr).toContain('not installed');
  });

  it('plugin update rejects non-existent plugin', async () => {
    const { stderr, code } = await runPluginCli(['plugin', 'update', '__nonexistent_plugin_xyz__']);
    expect(code).toBe(1);
  });

  it('plugin update without name or --all shows error', async () => {
    const { stderr, code } = await runPluginCli(['plugin', 'update']);
    expect(code).toBe(2);
    expect(stderr).toContain('specify a plugin name');
  });
});
