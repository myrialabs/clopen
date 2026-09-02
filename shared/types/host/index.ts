/**
 * The identity of a machine Clopen can act on.
 *
 * Ports, containers and everything host-scoped that follows them address a
 * machine the same way: `local` is the machine Clopen itself runs on, and any
 * other id is a saved SSH connection. `local` is not a special case — it is
 * simply the host whose id happens to be `local`, which is what lets one store
 * and one scan serve both the More Tools panel and the SSH Client tab.
 */

export type HostId = string;

export const LOCAL_HOST_ID: HostId = 'local';

/** True when this id names the machine Clopen is running on. */
export function isLocalHost(hostId: HostId): boolean {
	return hostId === LOCAL_HOST_ID;
}
