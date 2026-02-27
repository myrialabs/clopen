import type { IconName } from '$shared/types/ui/icons';

/**
 * Comprehensive folder icon mapping - using Material Icons with open/closed states
 * This file contains mappings for common folder names to their specific icons
 * Uses material:folder and material:folder-open for consistency and availability
 */
export const folderIcons: Record<string, { closed: IconName; opened: IconName }> = {
	// === DEVELOPMENT FRAMEWORKS ===
	'android': {
		closed: 'material:folder-android',
		opened: 'material:folder-android-open'
	},
	'ios': {
		closed: 'material:folder-ios',
		opened: 'material:folder-ios-open'
	},
	'expo': {
		closed: 'material:folder-expo',
		opened: 'material:folder-expo-open'
	},
	'electron': {
		closed: 'material:folder-app',
		opened: 'material:folder-app-open'
	},
	'tauri': {
		closed: 'material:folder-src-tauri',
		opened: 'material:folder-src-tauri-open'
	},
	'next': {
		closed: 'material:folder-next',
		opened: 'material:folder-next-open'
	},
	'nuxt': {
		closed: 'material:folder-nuxt',
		opened: 'material:folder-nuxt-open'
	},
	'svelte': {
		closed: 'material:folder-svelte',
		opened: 'material:folder-svelte-open'
	},
	'aurelia': {
		closed: 'material:folder-aurelia',
		opened: 'material:folder-aurelia-open'
	},
	'meteor': {
		closed: 'material:folder-meta',
		opened: 'material:folder-meta-open'
	},
	'vue': {
		closed: 'material:folder-vue',
		opened: 'material:folder-vue-open'
	},
	'react': {
		closed: 'material:folder-react-components',
		opened: 'material:folder-react-components-open'
	},
	'angular': {
		closed: 'material:folder-angular',
		opened: 'material:folder-angular-open'
	},
	'ember': {
		closed: 'material:folder-app',
		opened: 'material:folder-app-open'
	},
	'gatsby': {
		closed: 'material:folder-app',
		opened: 'material:folder-app-open'
	},
	'gridsome': {
		closed: 'material:folder-app',
		opened: 'material:folder-app-open'
	},
	'astro': {
		closed: 'material:folder-astro',
		opened: 'material:folder-astro-open'
	},
	'remix': {
		closed: 'material:folder-app',
		opened: 'material:folder-app-open'
	},
	'qwik': {
		closed: 'material:folder-app',
		opened: 'material:folder-app-open'
	},

	// === PROGRAMMING LANGUAGES ===
	'js': {
		closed: 'material:folder-javascript',
		opened: 'material:folder-javascript-open'
	},
	'javascript': {
		closed: 'material:folder-javascript',
		opened: 'material:folder-javascript-open'
	},
	'typescript': {
		closed: 'material:folder-typescript',
		opened: 'material:folder-typescript-open'
	},
	'ts': {
		closed: 'material:folder-typescript',
		opened: 'material:folder-typescript-open'
	},
	'python': {
		closed: 'material:folder-python',
		opened: 'material:folder-python-open'
	},
	'py': {
		closed: 'material:folder-python',
		opened: 'material:folder-python-open'
	},
	'php': {
		closed: 'material:folder-php',
		opened: 'material:folder-php-open'
	},
	'node': {
		closed: 'material:folder-node',
		opened: 'material:folder-node-open'
	},
	'nodejs': {
		closed: 'material:folder-node',
		opened: 'material:folder-node-open'
	},
	'dart': {
		closed: 'material:folder-dart',
		opened: 'material:folder-dart-open'
	},
	'flutter': {
		closed: 'material:folder-flutter',
		opened: 'material:folder-flutter-open'
	},
	'java': {
		closed: 'material:folder-java',
		opened: 'material:folder-java-open'
	},
	'rust': {
		closed: 'material:folder-rust',
		opened: 'material:folder-rust-open'
	},
	'go': {
		closed: 'material:folder-app',
		opened: 'material:folder-app-open'
	},
	'golang': {
		closed: 'material:folder-app',
		opened: 'material:folder-app-open'
	},
	'scala': {
		closed: 'material:folder-scala',
		opened: 'material:folder-scala-open'
	},
	'lua': {
		closed: 'material:folder-lua',
		opened: 'material:folder-lua-open'
	},
	'luau': {
		closed: 'material:folder-luau',
		opened: 'material:folder-luau-open'
	},

	// === COMMON PROJECT STRUCTURE ===
	'src': {
		closed: 'material:folder-src',
		opened: 'material:folder-src-open'
	},
	'source': {
		closed: 'material:folder-src',
		opened: 'material:folder-src-open'
	},
	'lib': {
		closed: 'material:folder-lib',
		opened: 'material:folder-lib-open'
	},
	'library': {
		closed: 'material:folder-lib',
		opened: 'material:folder-lib-open'
	},
	'dist': {
		closed: 'material:folder-dist',
		opened: 'material:folder-dist-open'
	},
	'build': {
		closed: 'material:folder-dist',
		opened: 'material:folder-dist-open'
	},
	'public': {
		closed: 'material:folder-public',
		opened: 'material:folder-public-open'
	},
	'static': {
		closed: 'material:folder-public',
		opened: 'material:folder-public-open'
	},
	'assets': {
		closed: 'material:folder-base',
		opened: 'material:folder-base-open'
	},
	'private': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},

	// === TESTING ===
	'test': {
		closed: 'material:folder-test',
		opened: 'material:folder-test-open'
	},
	'tests': {
		closed: 'material:folder-test',
		opened: 'material:folder-test-open'
	},
	'__tests__': {
		closed: 'material:folder-test',
		opened: 'material:folder-test-open'
	},
	'spec': {
		closed: 'material:folder-test',
		opened: 'material:folder-test-open'
	},
	'specs': {
		closed: 'material:folder-test',
		opened: 'material:folder-test-open'
	},
	'e2e': {
		closed: 'material:folder-test',
		opened: 'material:folder-test-open'
	},
	'cypress': {
		closed: 'material:folder-cypress',
		opened: 'material:folder-cypress-open'
	},
	'coverage': {
		closed: 'material:folder-coverage',
		opened: 'material:folder-coverage-open'
	},

	// === STYLING ===
	'css': {
		closed: 'material:folder-css',
		opened: 'material:folder-css-open'
	},
	'styles': {
		closed: 'material:folder-css',
		opened: 'material:folder-css-open'
	},
	'style': {
		closed: 'material:folder-css',
		opened: 'material:folder-css-open'
	},
	'sass': {
		closed: 'material:folder-sass',
		opened: 'material:folder-sass-open'
	},
	'scss': {
		closed: 'material:folder-sass',
		opened: 'material:folder-sass-open'
	},
	'less': {
		closed: 'material:folder-less',
		opened: 'material:folder-less-open'
	},

	// === CONFIGURATION ===
	'config': {
		closed: 'material:folder-config',
		opened: 'material:folder-config-open'
	},
	'configuration': {
		closed: 'material:folder-config',
		opened: 'material:folder-config-open'
	},
	'settings': {
		closed: 'material:folder-config',
		opened: 'material:folder-config-open'
	},
	'.vscode': {
		closed: 'material:folder-vscode',
		opened: 'material:folder-vscode-open'
	},

	// === DOCUMENTATION ===
	'docs': {
		closed: 'material:folder-docs',
		opened: 'material:folder-docs-open'
	},
	'doc': {
		closed: 'material:folder-docs',
		opened: 'material:folder-docs-open'
	},
	'documentation': {
		closed: 'material:folder-docs',
		opened: 'material:folder-docs-open'
	},

	// === MEDIA ===
	'images': {
		closed: 'material:folder-images',
		opened: 'material:folder-images-open'
	},
	'img': {
		closed: 'material:folder-images',
		opened: 'material:folder-images-open'
	},
	'pictures': {
		closed: 'material:folder-images',
		opened: 'material:folder-images-open'
	},
	'pics': {
		closed: 'material:folder-images',
		opened: 'material:folder-images-open'
	},
	'fonts': {
		closed: 'material:folder-font',
		opened: 'material:folder-font-open'
	},
	'audio': {
		closed: 'material:folder-audio',
		opened: 'material:folder-audio-open'
	},
	'video': {
		closed: 'material:folder-video',
		opened: 'material:folder-video-open'
	},
	'videos': {
		closed: 'material:folder-video',
		opened: 'material:folder-video-open'
	},
	'favicon': {
		closed: 'material:folder-favicon',
		opened: 'material:folder-favicon-open'
	},
	'svg': {
		closed: 'material:folder-svg',
		opened: 'material:folder-svg-open'
	},
	'icons': {
		closed: 'material:folder-images',
		opened: 'material:folder-images-open'
	},

	// === ARCHITECTURE PATTERNS ===
	'components': {
		closed: 'material:folder-components',
		opened: 'material:folder-components-open'
	},
	'component': {
		closed: 'material:folder-components',
		opened: 'material:folder-components-open'
	},
	'controllers': {
		closed: 'material:folder-controller',
		opened: 'material:folder-controller-open'
	},
	'controller': {
		closed: 'material:folder-controller',
		opened: 'material:folder-controller-open'
	},
	'models': {
		closed: 'material:folder-base',
		opened: 'material:folder-base-open'
	},
	'model': {
		closed: 'material:folder-base',
		opened: 'material:folder-base-open'
	},
	'views': {
		closed: 'material:folder-views',
		opened: 'material:folder-views-open'
	},
	'view': {
		closed: 'material:folder-views',
		opened: 'material:folder-views-open'
	},
	'services': {
		closed: 'material:folder-base',
		opened: 'material:folder-base-open'
	},
	'service': {
		closed: 'material:folder-base',
		opened: 'material:folder-base-open'
	},
	'middleware': {
		closed: 'material:folder-middleware',
		opened: 'material:folder-middleware-open'
	},
	'routes': {
		closed: 'material:folder-routes',
		opened: 'material:folder-routes-open'
	},
	'route': {
		closed: 'material:folder-routes',
		opened: 'material:folder-routes-open'
	},
	'api': {
		closed: 'material:folder-api',
		opened: 'material:folder-api-open'
	},
	'apis': {
		closed: 'material:folder-api',
		opened: 'material:folder-api-open'
	},

	// === TOOLS & BUILD SYSTEMS ===
	'tools': {
		closed: 'material:folder-tools',
		opened: 'material:folder-tools-open'
	},
	'scripts': {
		closed: 'material:folder-scripts',
		opened: 'material:folder-scripts-open'
	},
	'script': {
		closed: 'material:folder-scripts',
		opened: 'material:folder-scripts-open'
	},
	'webpack': {
		closed: 'material:folder-webpack',
		opened: 'material:folder-webpack-open'
	},
	'gulp': {
		closed: 'material:folder-gulp',
		opened: 'material:folder-gulp-open'
	},
	'grunt': {
		closed: 'material:folder-tools',
		opened: 'material:folder-tools-open'
	},
	'gradle': {
		closed: 'material:folder-gradle',
		opened: 'material:folder-gradle-open'
	},
	'maven': {
		closed: 'material:folder-tools',
		opened: 'material:folder-tools-open'
	},

	// === PACKAGE MANAGERS ===
	'node_modules': {
		closed: 'material:folder-node',
		opened: 'material:folder-node-open'
	},
	'packages': {
		closed: 'material:folder-packages',
		opened: 'material:folder-packages-open'
	},
	'package': {
		closed: 'material:folder-packages',
		opened: 'material:folder-packages-open'
	},
	'bower_components': {
		closed: 'material:folder-bower',
		opened: 'material:folder-bower-open'
	},
	'yarn': {
		closed: 'material:folder-yarn',
		opened: 'material:folder-yarn-open'
	},
	'composer': {
		closed: 'material:folder-php',
		opened: 'material:folder-php-open'
	},
	'vendor': {
		closed: 'material:folder-lib',
		opened: 'material:folder-lib-open'
	},
	'nuget': {
		closed: 'material:folder-packages',
		opened: 'material:folder-packages-open'
	},
	'paket': {
		closed: 'material:folder-packages',
		opened: 'material:folder-packages-open'
	},

	// === VERSION CONTROL ===
	'.git': {
		closed: 'material:folder-git',
		opened: 'material:folder-git-open'
	},
	'.github': {
		closed: 'material:folder-github',
		opened: 'material:folder-github-open'
	},
	'.gitlab': {
		closed: 'material:folder-gitlab',
		opened: 'material:folder-gitlab-open'
	},

	// === CONTAINERIZATION & DEPLOYMENT ===
	'docker': {
		closed: 'material:folder-docker',
		opened: 'material:folder-docker-open'
	},
	'.docker': {
		closed: 'material:folder-docker',
		opened: 'material:folder-docker-open'
	},
	'kubernetes': {
		closed: 'material:folder-kubernetes',
		opened: 'material:folder-kubernetes-open'
	},
	'k8s': {
		closed: 'material:folder-kubernetes',
		opened: 'material:folder-kubernetes-open'
	},
	'vagrant': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'.devcontainer': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},

	// === CI/CD ===
	'.circleci': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'.travis': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'.buildkite': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'workflows': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},

	// === CLOUD PLATFORMS ===
	'aws': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'azure': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'gcp': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'google': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'.elasticbeanstalk': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},

	// === DATABASES ===
	'db': {
		closed: 'material:folder-database',
		opened: 'material:folder-database-open'
	},
	'database': {
		closed: 'material:folder-database',
		opened: 'material:folder-database-open'
	},
	'mysql': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'mongodb': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'mongo': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'redis': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'mariadb': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'arangodb': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'ravendb': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'memcached': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'prisma': {
		closed: 'material:folder-prisma',
		opened: 'material:folder-prisma-open'
	},
	'drizzle': {
		closed: 'material:folder-drizzle',
		opened: 'material:folder-drizzle-open'
	},

	// === STATE MANAGEMENT ===
	'redux': {
		closed: 'material:folder-redux-reducer',
		opened: 'material:folder-redux-reducer-open'
	},
	'store': {
		closed: 'material:folder-store',
		opened: 'material:folder-store-open'
	},
	'stores': {
		closed: 'material:folder-store',
		opened: 'material:folder-store-open'
	},
	'bloc': {
		closed: 'material:folder-bloc',
		opened: 'material:folder-bloc-open'
	},
	'cubit': {
		closed: 'material:folder-bloc',
		opened: 'material:folder-bloc-open'
	},
	'ngrx': {
		closed: 'material:folder-ngrx-store',
		opened: 'material:folder-ngrx-store-open'
	},
	'vuex': {
		closed: 'material:folder-vuex-store',
		opened: 'material:folder-vuex-store-open'
	},

	// === OTHER COMMON FOLDERS ===
	'temp': {
		closed: 'material:folder-temp',
		opened: 'material:folder-temp-open'
	},
	'tmp': {
		closed: 'material:folder-temp',
		opened: 'material:folder-temp-open'
	},
	'templates': {
		closed: 'material:folder-template',
		opened: 'material:folder-template-open'
	},
	'template': {
		closed: 'material:folder-template',
		opened: 'material:folder-template-open'
	},
	'themes': {
		closed: 'material:folder-theme',
		opened: 'material:folder-theme-open'
	},
	'theme': {
		closed: 'material:folder-theme',
		opened: 'material:folder-theme-open'
	},
	'shared': {
		closed: 'material:folder-shared',
		opened: 'material:folder-shared-open'
	},
	'common': {
		closed: 'material:folder-shared',
		opened: 'material:folder-shared-open'
	},
	'utils': {
		closed: 'material:folder-utils',
		opened: 'material:folder-utils-open'
	},
	'utilities': {
		closed: 'material:folder-utils',
		opened: 'material:folder-utils-open'
	},
	'helpers': {
		closed: 'material:folder-helper',
		opened: 'material:folder-helper-open'
	},
	'helper': {
		closed: 'material:folder-helper',
		opened: 'material:folder-helper-open'
	},
	'modules': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'module': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'plugins': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'plugin': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'extensions': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'logs': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'log': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'locale': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'locales': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'i18n': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'includes': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'include': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'interfaces': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'interface': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'typings': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'types': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'@types': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'json': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'binary': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'bin': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'certificates': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'cert': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'certs': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'hooks': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'hook': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'.husky': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'server': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'servers': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'client': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'clients': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'www': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'web': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'cli': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'app': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'apps': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'mocks': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'mock': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'notebooks': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'stories': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'story': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'storybook': {
		closed: 'material:folder-storybook',
		opened: 'material:folder-storybook-open'
	},

	// === SPECIFIC TECHNOLOGY FOLDERS ===
	'flow': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'mjml': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'nginx': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'platformio': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'snaplet': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'spin': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'sso': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'trunk': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'nix': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'mojo': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'minikube': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'macos': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'windows': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'linux': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'debian': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'vs': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'idea': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'.idea': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'chef': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'cake': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'blueprint': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'bot': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'bots': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'notifications': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'notification': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'dapr': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'datadog': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'dependabot': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'.dependabot': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'cmake': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'haxelib': {
		closed: 'material:folder-admin',
		opened: 'material:folder-admin-open'
	},
	'.changesets': {
		closed: 'material:folder-changesets',
		opened: 'material:folder-changesets-open'
	},

	// === ADDITIONAL MODERN FRAMEWORKS ===
	'turborepo': {
		closed: 'material:folder-turborepo',
		opened: 'material:folder-turborepo-open'
	},
	'turbo': {
		closed: 'material:folder-turborepo',
		opened: 'material:folder-turborepo-open'
	},
	'nx': {
		closed: 'material:folder-app',
		opened: 'material:folder-app-open'
	},
	'graphql': {
		closed: 'material:folder-graphql',
		opened: 'material:folder-graphql-open'
	},
	'gql': {
		closed: 'material:folder-graphql',
		opened: 'material:folder-graphql-open'
	},
	'firebase': {
		closed: 'material:folder-firebase',
		opened: 'material:folder-firebase-open'
	},
	'supabase': {
		closed: 'material:folder-supabase',
		opened: 'material:folder-supabase-open'
	},
	'vercel': {
		closed: 'material:folder-vercel',
		opened: 'material:folder-vercel-open'
	},
	'netlify': {
		closed: 'material:folder-netlify',
		opened: 'material:folder-netlify-open'
	}
};

/**
 * Get the appropriate folder icon based on folder name and open state
 */
export function getFolderIcon(folderName: string, isOpen: boolean): IconName {
	const folderMapping = folderIcons[folderName.toLowerCase()];
	
	if (folderMapping) {
		return isOpen ? folderMapping.opened : folderMapping.closed;
	}
	
	// Fallback to default folder icons
	return isOpen ? 'material:folder-base-open' : 'material:folder-base';
}