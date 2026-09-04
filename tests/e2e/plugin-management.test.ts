/**
 * E2E integration tests for plugin management commands.
 * Uses a real GitHub plugin (opencli-plugin-hot-digest) to verify the full
 * install → list → update → uninstall lifecycle in an isolated HOME.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli, parseJsonOutput } from './helpers.js';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-plugin-e2e-'));
const OPENCLI_HOME = path.join(TEST_HOME, '.opencli');
const PLUGINS_DIR = path.join(OPENCLI_HOME, 'plugins');
const PLUGIN_SOURCE = 'github:ByteYue/opencli-plugin-hot-digest';
const PLUGIN_NAME = 'hot-digest';
const PLUGIN_DIR = path.join(PLUGINS_DIR, PLUGIN_NAME);
const LOCK_FILE = path.join(OPENCLI_HOME, 'plugins.lock.json');

function runPluginCli(
  args: string[],
  opts: { timeout?: number; env?: Record<string, string> } = {},
) {
  return runCli(args, {
    ...opts,
    env: {
      HOME: TEST_HOME,
      USERPROFILE: TEST_HOME,
      ...opts.env,
    },
  });
}

describe('plugin management E2E', () => {
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
  it('plugin install clones and sets up a real plugin', async () => {
    // git clone + npm install of a real external repo has high, genuine
    // variance under normal (not even degraded) conditions — confirmed
    // locally on 2026-09-04 across repeat runs at ~60s, ~65s, and ~110s. The
    // old 60s budget had zero margin over even the fast end of that range,
    // which is what made this test time out on both CI runners in the same
    // run. Give it real headroom instead of a 1x-tight budget.
    const { stdout, code } = await runPluginCli(['plugin', 'install', PLUGIN_SOURCE], {
      timeout: 180_000,
    });
    expect(code).toBe(0);
    expect(stdout).toContain('installed successfully');
    expect(stdout).toContain(PLUGIN_NAME);

    // Verify the plugin directory was created
    expect(fs.existsSync(PLUGIN_DIR)).toBe(true);

    // Verify lock file was updated
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
    expect(lock[PLUGIN_NAME]).toBeDefined();
    expect(lock[PLUGIN_NAME].commitHash).toBeTruthy();
    expect(lock[PLUGIN_NAME].source).toMatchObject({
      kind: 'git',
    });
    expect(lock[PLUGIN_NAME].source.url).toContain('opencli-plugin-hot-digest');
    expect(lock[PLUGIN_NAME].installedAt).toBeTruthy();
  }, 180_000);

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
    expect(plugin.commands.length).toBeGreaterThan(0);
  });

  // ── plugin update ──
  it('plugin update succeeds on an installed plugin', async () => {
    // updatePlugin() re-clones the source and re-runs the npm install
    // lifecycle (see updatePlugin/postInstallLifecycle in src/plugin.ts) —
    // the same class of work as `plugin install` above, but observed to run
    // even longer: still timed out at a 180s budget on a macos-15 CI runner
    // on 2026-09-04 after `plugin install`'s own 180s budget had already
    // proven sufficient in the same run. Give real margin above the worst
    // case actually observed rather than incrementally chasing the ceiling.
    const { stdout, code } = await runPluginCli(['plugin', 'update', PLUGIN_NAME], {
      timeout: 300_000,
    });
    expect(code).toBe(0);
    expect(stdout).toContain('updated successfully');

    // Verify lock file has updatedAt
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
    expect(lock[PLUGIN_NAME].updatedAt).toBeTruthy();
  }, 300_000);

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
