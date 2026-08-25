import { describe, expect, test } from 'bun:test';
import {
	archiveBaseName,
	buildArchiveListCommand,
	buildCandidateName,
	buildCompressCommand,
	buildExtractCommand,
	joinRemote,
	normalizeRemote,
	parentOfRemote,
	parseArchiveTopLevelNames,
	splitRemoteName
} from './sftp';

describe('normalizeRemote', () => {
	test('collapses duplicate slashes and dot segments', () => {
		expect(normalizeRemote('/var//log/./nginx')).toBe('/var/log/nginx');
	});

	test('resolves parent segments', () => {
		expect(normalizeRemote('/var/log/../www')).toBe('/var/www');
	});

	test('cannot climb above the root', () => {
		expect(normalizeRemote('/../../etc')).toBe('/etc');
	});

	test('keeps leading parents on a relative path', () => {
		expect(normalizeRemote('../sibling')).toBe('../sibling');
	});

	test('an emptied relative path becomes the current directory', () => {
		expect(normalizeRemote('a/..')).toBe('.');
	});

	test('the root survives normalization', () => {
		expect(normalizeRemote('/')).toBe('/');
	});
});

describe('joinRemote', () => {
	test('joins a directory and a name', () => {
		expect(joinRemote('/var/log', 'nginx')).toBe('/var/log/nginx');
	});

	test('does not double the separator on a trailing slash', () => {
		expect(joinRemote('/var/log/', 'nginx')).toBe('/var/log/nginx');
	});

	test('joins onto the root', () => {
		expect(joinRemote('/', 'etc')).toBe('/etc');
	});

	test('an absolute name replaces the directory', () => {
		expect(joinRemote('/var/log', '/etc/hosts')).toBe('/etc/hosts');
	});

	test('a parent name climbs one level', () => {
		expect(joinRemote('/var/log', '..')).toBe('/var');
	});
});

describe('parentOfRemote', () => {
	test('drops the last segment', () => {
		expect(parentOfRemote('/var/log/nginx')).toBe('/var/log');
	});

	test('a top-level path has the root as its parent', () => {
		expect(parentOfRemote('/etc')).toBe('/');
	});

	test('the root is its own parent', () => {
		expect(parentOfRemote('/')).toBe('/');
	});
});

describe('buildCompressCommand', () => {
	test('zip does not get a -- separator', () => {
		// `zip -- archive.zip name` fails with "can't use -- before archive name".
		const command = buildCompressCommand(
			['/home/user/site', '/home/user/notes.txt'],
			'/home/user/backup.zip',
			'zip'
		);
		expect(command).not.toContain(' -- ');
		expect(command).toBe(
			`cd '/home/user' && zip -r -q '/home/user/backup.zip' './site' './notes.txt'`
		);
	});

	test('tar does get one, since GNU tar accepts it', () => {
		const command = buildCompressCommand(['/home/user/site'], '/home/user/backup.tar.gz', 'tar.gz');
		expect(command).toBe(`cd '/home/user' && tar -czf '/home/user/backup.tar.gz' -- 'site'`);
	});

	test('runs from the common parent so entries are stored by plain name', () => {
		const command = buildCompressCommand(['/var/www/html'], '/var/www/html.zip', 'zip');
		expect(command.startsWith(`cd '/var/www' &&`)).toBe(true);
		expect(command).toContain(`'./html'`);
	});

	test('a name starting with a dash is not read as an option', () => {
		const zipCommand = buildCompressCommand(['/home/user/-rf'], '/home/user/out.zip', 'zip');
		expect(zipCommand).toContain(`'./-rf'`);
		const tarCommand = buildCompressCommand(['/home/user/-rf'], '/home/user/out.tar.gz', 'tar.gz');
		expect(tarCommand).toContain(`-- '-rf'`);
	});

	test('a quote in a name cannot break out of the command', () => {
		const command = buildCompressCommand(["/home/user/it's"], '/home/user/out.zip', 'zip');
		expect(command).toContain(`'./it'\\''s'`);
	});
});

describe('buildExtractCommand', () => {
	test('picks unzip for a zip', () => {
		expect(buildExtractCommand('/home/user/a.zip', '/home/user')).toBe(
			`unzip -o -q '/home/user/a.zip' -d '/home/user'`
		);
	});

	test('keeping the existing files flips unzip from -o to -n', () => {
		expect(buildExtractCommand('/home/user/a.zip', '/home/user', true)).toBe(
			`unzip -n -q '/home/user/a.zip' -d '/home/user'`
		);
	});

	test('tar tries the quiet skip flag first and falls back to -k', () => {
		// --skip-old-files is GNU tar's; a BSD or macOS host only knows -k.
		const command = buildExtractCommand('/a/b.tar.gz', '/a', true);
		expect(command).toBe(
			`tar -xzf '/a/b.tar.gz' -C '/a' --skip-old-files 2>/dev/null || tar -xzf '/a/b.tar.gz' -C '/a' -k`
		);
	});

	test('a bare gz is left alone when the decompressed file is already there', () => {
		expect(buildExtractCommand('/a/access.log.gz', '/tmp', true)).toBe(
			`[ -e '/tmp/access.log' ] || gunzip -c '/a/access.log.gz' > '/tmp/access.log'`
		);
	});

	test('picks the matching decompressor for each tar flavour', () => {
		expect(buildExtractCommand('/a/b.tar.gz', '/a')).toContain('tar -xzf');
		expect(buildExtractCommand('/a/b.tgz', '/a')).toContain('tar -xzf');
		expect(buildExtractCommand('/a/b.tar.bz2', '/a')).toContain('tar -xjf');
		expect(buildExtractCommand('/a/b.tar.xz', '/a')).toContain('tar -xJf');
		expect(buildExtractCommand('/a/b.tar', '/a')).toContain('tar -xf');
	});

	test('a bare gz is decompressed to its stem in the destination', () => {
		expect(buildExtractCommand('/a/access.log.gz', '/tmp')).toBe(
			`gunzip -c '/a/access.log.gz' > '/tmp/access.log'`
		);
	});

	test('the suffix check is case-insensitive', () => {
		expect(buildExtractCommand('/a/B.ZIP', '/a')).toContain('unzip');
	});

	test('an unknown type is refused rather than guessed at', () => {
		expect(() => buildExtractCommand('/a/b.rar', '/a')).toThrow('does not know how to extract');
	});
});

describe('splitRemoteName', () => {
	test('splits a name from its extension', () => {
		expect(splitRemoteName('notes.txt')).toEqual({ stem: 'notes', suffix: '.txt' });
	});

	test('a leading dot is part of the name, not a suffix', () => {
		expect(splitRemoteName('.bashrc')).toEqual({ stem: '.bashrc', suffix: '' });
	});

	test('a compound archive suffix stays whole', () => {
		expect(splitRemoteName('site.tar.gz')).toEqual({ stem: 'site', suffix: '.tar.gz' });
	});

	test('a name with no dot at all has no suffix', () => {
		expect(splitRemoteName('logs')).toEqual({ stem: 'logs', suffix: '' });
	});
});

describe('buildCandidateName', () => {
	test('numbers a file before its extension', () => {
		expect(buildCandidateName('notes.txt', 2)).toBe('notes (2).txt');
	});

	test('numbers a folder at the end', () => {
		expect(buildCandidateName('logs', 3)).toBe('logs (3)');
	});

	test('numbers a tarball before its whole suffix', () => {
		expect(buildCandidateName('site.tar.gz', 2)).toBe('site (2).tar.gz');
	});
});

describe('archiveBaseName', () => {
	test('drops a compound suffix rather than half of it', () => {
		expect(archiveBaseName('/home/user/site.tar.gz')).toBe('site');
	});

	test('drops a single suffix', () => {
		expect(archiveBaseName('/home/user/backup.zip')).toBe('backup');
	});

	test('leaves a name that is only a suffix alone', () => {
		expect(archiveBaseName('/home/user/.zip')).toBe('.zip');
	});
});

describe('buildArchiveListCommand', () => {
	test('lists a zip with zipinfo and caps the output', () => {
		expect(buildArchiveListCommand('/a/b.zip', 100)).toBe(`unzip -Z1 '/a/b.zip' | head -n 100`);
	});

	test('lists a tarball with the matching decompressor', () => {
		expect(buildArchiveListCommand('/a/b.tar.xz', 100)).toBe(`tar -tJf '/a/b.tar.xz' | head -n 100`);
	});

	test('a bare gz has no index, so its single entry is named after itself', () => {
		expect(buildArchiveListCommand('/a/access.log.gz')).toBe(`echo 'access.log'`);
	});

	test('an unknown type is refused rather than guessed at', () => {
		expect(() => buildArchiveListCommand('/a/b.rar')).toThrow('does not know how to extract');
	});
});

describe('parseArchiveTopLevelNames', () => {
	test('collapses every entry to the name it creates in the destination', () => {
		const names = parseArchiveTopLevelNames('site/\nsite/index.html\nsite/css/app.css\nREADME.md');
		expect(names).toEqual(['site', 'README.md']);
	});

	test('strips the ./ prefix tar writes for an archive made from .', () => {
		expect(parseArchiveTopLevelNames('./\n./bin/run\n./bin/stop')).toEqual(['bin']);
	});

	test('an empty listing has no names', () => {
		expect(parseArchiveTopLevelNames('')).toEqual([]);
	});
});
