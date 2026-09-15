/**
 * Whether git tracks a dotenv file — the one question that can refuse a write.
 */

import { execGit } from '$backend/git/git-executor';
import { debug } from '$shared/utils/logger';

/**
 * `ls-files --error-unmatch` exits non-zero for an untracked path, which is the
 * answer we want rather than an error. A directory that is not a repository at
 * all also lands here, and "not tracked" is the correct reading: there is no
 * commit that could carry the file anywhere.
 */
export async function isTrackedInGit(root: string, fileName: string): Promise<boolean> {
	try {
		const result = await execGit(['ls-files', '--error-unmatch', '--', fileName], root, {
			okExitCodes: [1, 128]
		});
		return result.exitCode === 0;
	} catch (error) {
		// git missing, or a path git refuses to read. Treating an unknown answer
		// as "tracked" is the safe direction: the cost is a variable the user has
		// to paste once, against the cost of committing a live password.
		debug.warn('env-files', `Could not check whether ${fileName} is tracked: ${error}`);
		return true;
	}
}
