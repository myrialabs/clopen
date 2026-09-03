import { containerArgv } from '/Users/platkadigital/Codes/MyriaLabs/clopen/backend/containers/runtime';
import { parseDiskUsage, parseStats, parseDockerNetworks, parseNetworkMembership, linkUsage } from '/Users/platkadigital/Codes/MyriaLabs/clopen/backend/containers/parse';
import { HostContainerScanner } from '/Users/platkadigital/Codes/MyriaLabs/clopen/backend/containers/scan';
import { LocalCommandRunner, localPlatform } from '/Users/platkadigital/Codes/MyriaLabs/clopen/backend/host/runner';

const platform = localPlatform();
const runner = new LocalCommandRunner();

const df = await runner.run(containerArgv('docker', platform, ['system', 'df', '--format', '{{json .}}']), 60000);
console.log('df exit', df.code);
for (const row of parseDiskUsage(df.stdout, 'docker').rows) {
  console.log(' ', row.kind.padEnd(12), 'total', String(row.total).padEnd(5), 'active', String(row.active).padEnd(4), 'size', row.size.padEnd(10), 'reclaimable', row.reclaimable);
}

const scanner = new HostContainerScanner('local', 'this machine', runner, platform);
const started = Date.now();
const result = await scanner.scan();
console.log('scan with networks in', Date.now() - started, 'ms | networks:', result.networks.length);
for (const net of result.networks.slice(0, 4)) console.log('  -', net.name.padEnd(28), net.driver, '| predefined', net.predefined, '| usedBy', net.usedBy.join(',') || '(none)');
console.log('  unused networks:', result.networks.filter(n => !n.predefined && n.usedBy.length === 0).length);

const target = result.entries.find((e) => e.state === 'running')!;
const t0 = Date.now();
const stats = await runner.run(containerArgv('docker', platform, ['stats', '--no-stream', '--format', '{{json .}}', target.id]), 30000);
console.log('stats exit', stats.code, 'in', Date.now() - t0, 'ms ->', JSON.stringify(parseStats(stats.stdout)));
