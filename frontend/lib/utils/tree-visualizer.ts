/**
 * Helper utilities for visualizing tree hierarchy structure
 * Used for debugging and analyzing checkpoint/message tree structure
 */

import type { DatabaseMessage } from '$shared/types/database/schema';
import { debug } from '$shared/utils/logger';

export interface TreeNode {
	id: string;
	messageText: string;
	timestamp: string;
	branchId: string | null;
	parentId: string | null;
	children: TreeNode[];
	level: number; // Tree level (0 = main, 1 = branch from main, 2 = branch from branch, etc.)
}

/**
 * Build tree structure from messages
 */
export function buildTreeFromMessages(messages: DatabaseMessage[]): TreeNode[] {
	const nodeMap = new Map<string, TreeNode>();
	const roots: TreeNode[] = [];

	// Create nodes
	messages.forEach(msg => {
		const sdkMessage = JSON.parse(msg.sdk_message);

		// Only process user messages (checkpoints)
		if (sdkMessage.type !== 'user') return;

		const messageText = extractMessageText(sdkMessage);
		if (!messageText.trim()) return;

		nodeMap.set(msg.id, {
			id: msg.id,
			messageText: messageText.trim().slice(0, 50),
			timestamp: msg.timestamp,
			branchId: msg.branch_id || null,
			parentId: msg.parent_message_id || null,
			children: [],
			level: 0
		});
	});

	// Build tree structure
	nodeMap.forEach(node => {
		if (node.parentId && nodeMap.has(node.parentId)) {
			const parent = nodeMap.get(node.parentId)!;
			parent.children.push(node);
			node.level = parent.level + (node.branchId ? 1 : 0);
		} else {
			roots.push(node);
		}
	});

	// Sort children by timestamp
	nodeMap.forEach(node => {
		node.children.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
	});

	roots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

	return roots;
}

/**
 * Extract message text from SDK message
 */
function extractMessageText(sdkMessage: any): string {
	if ('message' in sdkMessage && sdkMessage.message?.content) {
		const content = sdkMessage.message.content;
		if (typeof content === 'string') {
			return content;
		} else if (Array.isArray(content)) {
			const textBlock = content.find((item: any) => typeof item === 'object' && 'text' in item);
			if (textBlock && 'text' in textBlock) {
				return textBlock.text;
			}
		}
	}
	return '';
}

/**
 * Generate ASCII tree visualization
 */
export function generateTreeASCII(roots: TreeNode[]): string {
	const lines: string[] = [];

	function traverse(node: TreeNode, prefix: string = '', isLast: boolean = true) {
		// Node line
		const connector = isLast ? '└─' : '├─';
		const branchTag = node.branchId ? ` [branch:${node.branchId}]` : '';
		const levelTag = ` (level ${node.level})`;
		lines.push(`${prefix}${connector} ${node.messageText}${branchTag}${levelTag}`);

		// Children
		const childPrefix = prefix + (isLast ? '  ' : '│ ');
		node.children.forEach((child, index) => {
			const isLastChild = index === node.children.length - 1;
			traverse(child, childPrefix, isLastChild);
		});
	}

	roots.forEach((root, index) => {
		const isLast = index === roots.length - 1;
		traverse(root, '', isLast);
	});

	return lines.join('\n');
}

/**
 * Generate compact list format (like your expected structure)
 */
export function generateTreeList(roots: TreeNode[]): string {
	const lines: string[] = [];

	function traverse(node: TreeNode, indent: number = 0) {
		const indentStr = '  '.repeat(indent);
		const branchTag = node.branchId ? ` [branch:${node.branchId}]` : '';
		lines.push(`${indentStr}- ${node.messageText}${branchTag}`);

		node.children.forEach(child => {
			// Increase indent if child has different branchId (is a branch)
			const childIndent = child.branchId && child.branchId !== node.branchId
				? indent + 1
				: indent;
			traverse(child, childIndent);
		});
	}

	roots.forEach(root => {
		traverse(root, 0);
	});

	return lines.join('\n');
}

/**
 * Log tree structure with detailed analysis
 */
export function logTreeStructure(
	sessionId: string,
	messages: DatabaseMessage[],
	currentHead: string | null,
	label: string = 'Tree Structure'
) {
	debug.log('checkpoint', `${label} - Session: ${sessionId}`);
	debug.log('checkpoint', `Current HEAD: ${currentHead || 'none'}`);
	debug.log('checkpoint', `Total messages: ${messages.length}`);

	const roots = buildTreeFromMessages(messages);

	debug.log('checkpoint', 'Tree Structure (ASCII):');
	debug.log('checkpoint', generateTreeASCII(roots));

	debug.log('checkpoint', '\nTree Structure (List format):');
	debug.log('checkpoint', generateTreeList(roots));

	// Additional analysis
	const mainTimelineCount = roots.length;
	const branchCount = messages.filter(m => m.branch_id && m.branch_id !== '').length;
	const uniqueBranches = new Set(messages.map(m => m.branch_id).filter(Boolean)).size;

	debug.log('checkpoint', '\nTree Statistics:');
	debug.log('checkpoint', `- Main timeline nodes: ${mainTimelineCount}`);
	debug.log('checkpoint', `- Total branch messages: ${branchCount}`);
	debug.log('checkpoint', `- Unique branches: ${uniqueBranches}`);
}

/**
 * Log parent-child relationships
 */
export function logParentChildRelationships(messages: DatabaseMessage[]) {
	debug.log('checkpoint', '\nParent-Child Relationships:');

	messages.forEach(msg => {
		const sdkMessage = JSON.parse(msg.sdk_message);
		if (sdkMessage.type !== 'user') return;

		const messageText = extractMessageText(sdkMessage).trim().slice(0, 30);
		const parentId = msg.parent_message_id || 'none';
		const branchId = msg.branch_id || 'none';

		debug.log('checkpoint', `${messageText}`);
		debug.log('checkpoint', `  ID: ${msg.id}`);
		debug.log('checkpoint', `  Parent: ${parentId}`);
		debug.log('checkpoint', `  Branch: ${branchId}`);
		debug.log('checkpoint', `  Timestamp: ${msg.timestamp}`);
		debug.log('checkpoint', '');
	});

	debug.log('checkpoint', '-'.repeat(80) + '\n');
}

/**
 * Validate tree structure and report issues
 */
export function validateTreeStructure(
	messages: DatabaseMessage[],
	expectedStructure?: string
): { valid: boolean; issues: string[] } {
	const issues: string[] = [];
	const messageMap = new Map(messages.map(m => [m.id, m]));

	// Check for orphaned nodes (parent_id points to non-existent message)
	messages.forEach(msg => {
		if (msg.parent_message_id && !messageMap.has(msg.parent_message_id)) {
			issues.push(`Message ${msg.id} has non-existent parent ${msg.parent_message_id}`);
		}
	});

	// Check for circular references
	const visited = new Set<string>();
	const recursionStack = new Set<string>();

	function detectCycle(msgId: string): boolean {
		if (recursionStack.has(msgId)) {
			issues.push(`Circular reference detected at message ${msgId}`);
			return true;
		}
		if (visited.has(msgId)) return false;

		visited.add(msgId);
		recursionStack.add(msgId);

		const msg = messageMap.get(msgId);
		if (msg && msg.parent_message_id) {
			detectCycle(msg.parent_message_id);
		}

		recursionStack.delete(msgId);
		return false;
	}

	messages.forEach(msg => {
		if (!visited.has(msg.id)) {
			detectCycle(msg.id);
		}
	});

	// Compare with expected structure if provided
	if (expectedStructure) {
		const roots = buildTreeFromMessages(messages);
		const actualStructure = generateTreeList(roots);

		// Normalize whitespace for comparison
		const normalizedExpected = expectedStructure.trim().replace(/\s+/g, ' ');
		const normalizedActual = actualStructure.trim().replace(/\s+/g, ' ');

		if (normalizedExpected !== normalizedActual) {
			issues.push('Tree structure does not match expected structure');
			debug.log('checkpoint', '\nExpected structure:');
			debug.log('checkpoint', expectedStructure);
			debug.log('checkpoint', '\nActual structure:');
			debug.log('checkpoint', actualStructure);
		}
	}

	return {
		valid: issues.length === 0,
		issues
	};
}

/**
 * Compare two tree states and report differences
 */
export function compareTreeStates(
	beforeMessages: DatabaseMessage[],
	afterMessages: DatabaseMessage[],
	operationLabel: string
) {
	debug.log('checkpoint', `Tree State Comparison - ${operationLabel}`);

	debug.log('checkpoint', 'BEFORE:');
	const beforeRoots = buildTreeFromMessages(beforeMessages);
	debug.log('checkpoint', generateTreeList(beforeRoots));

	debug.log('checkpoint', '\nAFTER:');
	const afterRoots = buildTreeFromMessages(afterMessages);
	debug.log('checkpoint', generateTreeList(afterRoots));

	// Analyze changes
	const beforeIds = new Set(beforeMessages.map(m => m.id));
	const afterIds = new Set(afterMessages.map(m => m.id));

	const added = afterMessages.filter(m => !beforeIds.has(m.id));
	const removed = beforeMessages.filter(m => !afterIds.has(m.id));

	const modified = afterMessages.filter(m => {
		const before = beforeMessages.find(bm => bm.id === m.id);
		if (!before) return false;
		return before.branch_id !== m.branch_id || before.parent_message_id !== m.parent_message_id;
	});

	debug.log('checkpoint', '\nChanges:');
	debug.log('checkpoint', `- Added: ${added.length}`);
	debug.log('checkpoint', `- Removed: ${removed.length}`);
	debug.log('checkpoint', `- Modified: ${modified.length}`);

	if (modified.length > 0) {
		debug.log('checkpoint', '\nModified messages:');
		modified.forEach(m => {
			const before = beforeMessages.find(bm => bm.id === m.id)!;
			debug.log('checkpoint', `  ${m.id}:`);
			if (before.parent_message_id !== m.parent_message_id) {
				debug.log('checkpoint', `    Parent: ${before.parent_message_id} → ${m.parent_message_id}`);
			}
			if (before.branch_id !== m.branch_id) {
				debug.log('checkpoint', `    Branch: ${before.branch_id || 'none'} → ${m.branch_id || 'none'}`);
			}
		});
	}

	debug.log('checkpoint', `${'='.repeat(80)}\n`);
}
