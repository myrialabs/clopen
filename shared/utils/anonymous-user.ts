import { debug } from '$shared/utils/logger';

/**
 * Anonymous User Management
 * Client-side utilities for managing anonymous user identities
 * Server-side generation via WebSocket user:anonymous
 */

// Dynamic import to avoid circular dependency and SSR issues
let wsClient: any = null;
async function getWS() {
	if (!wsClient && typeof window !== 'undefined') {
		const module = await import('$frontend/lib/utils/ws');
		wsClient = module.default;
	}
	return wsClient;
}

export interface AnonymousUser {
  id: string;
  name: string;
  color: string;
  avatar: string;
  createdAt: string;
}

/**
 * Generate a unique anonymous user identity via WebSocket
 */
async function generateAnonymousUserFromServer(): Promise<AnonymousUser | null> {
  try {
    const ws = await getWS();
    if (!ws) {
      debug.error('user', 'WebSocket client not available');
      return null;
    }

    const response = await ws.http('user:anonymous', {});

    debug.log('user', '✅ Generated anonymous user from server:', response.name);
    return response;
  } catch (error) {
    debug.error('user', 'Error calling anonymous user API:', error);
    return null;
  }
}

/**
 * Get or create anonymous user from localStorage
 * If not found, generates new user via server API
 */
export async function getOrCreateAnonymousUser(): Promise<AnonymousUser | null> {
  // Check if we're in browser environment
  if (typeof window === 'undefined') {
    debug.warn('user', 'Cannot create anonymous user on server side');
    return null;
  }

  const stored = localStorage.getItem('claude-anonymous-user');

  if (stored) {
    try {
      const user = JSON.parse(stored);
      // Validate the stored user has all required fields
      if (user.id && user.name && user.color && user.avatar) {
        debug.log('user', 'Found existing anonymous user:', user.name);
        return user;
      }
    } catch (e) {
      debug.error('user', 'Invalid stored anonymous user:', e);
    }
  }

  // Generate new user via server API
  debug.log('user', 'No valid stored user, generating new one from server...');
  const newUser = await generateAnonymousUserFromServer();

  if (newUser) {
    localStorage.setItem('claude-anonymous-user', JSON.stringify(newUser));
    return newUser;
  }

  debug.error('user', 'Failed to generate anonymous user');
  return null;
}

/**
 * Get current anonymous user from localStorage
 */
export function getCurrentAnonymousUser(): AnonymousUser | null {
  // Check if we're in browser environment
  if (typeof window === 'undefined') {
    return null;
  }

  const stored = localStorage.getItem('claude-anonymous-user');

  if (stored) {
    try {
      return JSON.parse(stored);
    } catch (e) {
      debug.error('user', 'Failed to parse anonymous user:', e);
    }
  }

  return null;
}

/**
 * Update anonymous user name
 * Updates via WebSocket
 */
export async function updateAnonymousUserName(newName: string): Promise<AnonymousUser | null> {
  // Check if we're in browser environment
  if (typeof window === 'undefined') {
    debug.error('user', 'Cannot update user name on server side');
    return null;
  }

  const currentUser = getCurrentAnonymousUser();

  if (!currentUser) {
    debug.error('user', 'No current anonymous user found');
    return null;
  }

  // Validate name (basic validation)
  if (!newName || newName.trim().length === 0) {
    debug.error('user', 'Invalid name provided');
    return null;
  }

  const trimmedName = newName.trim();

  // Call server via WebSocket to get updated user
  try {
    const ws = await getWS();
    if (!ws) {
      debug.error('user', 'WebSocket client not available');
      return null;
    }

    const response = await ws.http('user:update', {
      userId: currentUser.id,
      newName: trimmedName
    });

    // Save to localStorage
    localStorage.setItem('claude-anonymous-user', JSON.stringify(response));
    debug.log('user', '✅ Updated user name:', response.name);
    return response;
  } catch (error) {
    debug.error('user', 'Error calling update user API:', error);
    return null;
  }
}

/**
 * Format user display name (shorter version for UI)
 */
export function formatUserDisplayName(user: AnonymousUser): string {
  // Extract just the animal and number for shorter display
  const parts = user.name.split(' ');
  if (parts.length >= 3) {
    return `${parts[1]} ${parts[2]}`;
  }
  return user.name;
}