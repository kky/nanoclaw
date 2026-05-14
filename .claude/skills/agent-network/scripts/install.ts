/**
 * Install the /agent-network skill.
 *
 * Idempotent. Each step checks state first and skips if already done.
 *
 * Usage:
 *   pnpm exec tsx .claude/skills/agent-network/scripts/install.ts
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Run via `pnpm exec tsx .claude/skills/agent-network/scripts/install.ts`
// from the project root — same convention as other skill scripts.
const PROJECT_ROOT = process.cwd();
const NETWORK_BARREL = path.join(PROJECT_ROOT, 'src/modules/network/index.ts');
const PROVIDER_IMPORT = "import './squid-policy-provider.js';";
const BUILD_SCRIPT = path.join(PROJECT_ROOT, 'container/squid/build.sh');

if (!fs.existsSync(NETWORK_BARREL)) {
  console.error(`ERROR: cannot find ${NETWORK_BARREL}`);
  console.error('Run this script from the NanoClaw project root.');
  process.exit(2);
}

function step(label: string, fn: () => void): void {
  process.stdout.write(`==> ${label} ... `);
  try {
    fn();
    process.stdout.write('done\n');
  } catch (err) {
    process.stdout.write('FAILED\n');
    console.error(err);
    throw err;
  }
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

function appendBarrelImport(): void {
  const current = fs.readFileSync(NETWORK_BARREL, 'utf8');
  if (current.includes(PROVIDER_IMPORT)) return; // already present

  // Append at the end of the file, preceded by a blank line if the file
  // doesn't already end with one. Keep the existing exports intact.
  const sep = current.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(NETWORK_BARREL, `${current}${sep}\n${PROVIDER_IMPORT}\n`);
}

function buildSquidImage(): void {
  if (!fs.existsSync(BUILD_SCRIPT)) {
    throw new Error(`Squid build script missing at ${BUILD_SCRIPT}`);
  }
  run('bash', [BUILD_SCRIPT]);
}

function rebuildDist(): void {
  // Wipe dist/ so any stale entries from previous shapes don't linger.
  fs.rmSync(path.join(PROJECT_ROOT, 'dist'), { recursive: true, force: true });
  execSync('pnpm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
}

function printBounceInstructions(): void {
  console.log('');
  console.log('Install complete. To activate the provider, restart the host:');
  console.log('');
  console.log('  macOS:   launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-<install-slug>');
  console.log('  Linux:   systemctl --user restart nanoclaw-v2-<install-slug>');
  console.log('');
  console.log('Watch logs/nanoclaw.log for `squid-policy-provider:` lines on first boot.');
  console.log('After the bounce, configure agents via:');
  console.log('  pnpm exec tsx .claude/skills/agent-network/scripts/configure.ts --list-agents');
}

function main(): void {
  step('Build Squid image', buildSquidImage);
  step('Register SquidNetworkPolicyProvider in network barrel', appendBarrelImport);
  step('Rebuild dist/', rebuildDist);
  printBounceInstructions();
}

main();
