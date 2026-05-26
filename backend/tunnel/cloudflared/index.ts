/**
 * Cloudflared Module
 *
 * Custom replacement for the `cloudflared` npm package.
 * Provides binary management and tunnel process control.
 */

export { getBinaryPath, isBinaryInstalled, installBinary, resolveCloudflaredBinary } from './binary';
export {
	CloudflaredTunnel,
	CloudflaredMissingError,
	type ConnectionInfo,
	type LoginHandle,
	type LoginCallbacks,
	type LoginOptions,
	type CreateTunnelOptions,
	type CreateTunnelResult,
	type DeleteTunnelOptions,
	type DeleteTunnelResult,
	type RouteDnsOptions,
	type RouteDnsResult,
	type ListTunnelsOptions,
	type TunnelListEntry
} from './tunnel';
