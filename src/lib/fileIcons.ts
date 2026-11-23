// Which icon and which accent each file and folder gets in the explorer. Pure, no runtime
// imports (node --test). The icons are lucide's (components/FileIcon.tsx maps the ids); the
// accents are tones that styles.css derives from the theme's ANSI colors, toned down toward
// the muted text so the tree stays calm ("mono" turns them all into the text color).

export type FileIconId =
  | 'file'
  | 'file-code'
  | 'file-markup'
  | 'file-terminal'
  | 'file-braces'
  | 'file-cog'
  | 'file-key'
  | 'file-lock'
  | 'file-text'
  | 'file-spreadsheet'
  | 'file-slides'
  | 'file-image'
  | 'file-archive'
  | 'file-video'
  | 'file-audio'
  | 'file-font'
  | 'file-binary'
  | 'file-project'
  | 'file-database'
  | 'file-badge'
  | 'file-symlink'
  | 'app'
  | 'package'
  | 'container'
  | 'git'
  | 'readme'
  | 'agents'
  | 'folder'
  | 'folder-open'
  | 'folder-code'
  | 'folder-tests'
  | 'folder-modules'
  | 'folder-git'
  | 'folder-config'
  | 'folder-docs'
  | 'folder-output'
  | 'folder-symlink';

/** Accents, from the theme (`--tone-<name>` in styles.css). */
export type Tone = 'muted' | 'folder' | 'accent' | 'blue' | 'cyan' | 'green' | 'yellow' | 'orange' | 'red' | 'magenta' | 'purple';

export interface FileIconSpec {
  icon: FileIconId;
  tone: Tone;
}

const spec = (icon: FileIconId, tone: Tone): FileIconSpec => ({ icon, tone });

/** Extension (lowercase, without the dot) → icon. */
const BY_EXTENSION: Record<string, FileIconSpec> = {};
const add = (extensions: string, icon: FileIconId, tone: Tone) => {
  for (const ext of extensions.split(' ')) BY_EXTENSION[ext] = spec(icon, tone);
};

// Code, one accent per language where it helps tell them apart.
add('ts tsx mts cts', 'file-code', 'blue');
add('js jsx mjs cjs', 'file-code', 'yellow');
add('py pyi pyw ipynb', 'file-code', 'green');
add('rs', 'file-code', 'orange');
add('go', 'file-code', 'cyan');
add('java kt kts scala groovy', 'file-code', 'red');
add('cs csx fs fsx vb', 'file-code', 'magenta');
add('php', 'file-code', 'purple');
add('dart', 'file-code', 'cyan');
add('c h cpp cc cxx hpp hh m mm', 'file-code', 'blue');
add('rb erb', 'file-code', 'red');
add('swift', 'file-code', 'orange');
add('lua r jl zig nim ex exs elm clj hs ml', 'file-code', 'purple');
add('vue svelte astro', 'file-code', 'green');
add('razor cshtml', 'file-code', 'magenta');
add('sql psql', 'file-database', 'yellow');
add('db sqlite sqlite3 mdb accdb', 'file-database', 'muted');
add('sh bash zsh fish ps1 psm1 psd1 bat cmd', 'file-terminal', 'green');
// Web.
add('html htm xhtml', 'file-markup', 'orange');
add('css', 'file-markup', 'blue');
add('scss sass less styl', 'file-markup', 'magenta');
// Data and configuration.
add('json jsonc json5 jsonl geojson webmanifest', 'file-braces', 'yellow');
add('yaml yml toml ini cfg conf properties editorconfig', 'file-cog', 'muted');
add('xml xsd xsl xslt plist xaml resx config', 'file-markup', 'muted');
add('csv tsv', 'file-spreadsheet', 'green');
add('env', 'file-key', 'yellow');
add('lock', 'file-lock', 'muted');
add('pem key crt cer pfx p12 pub kdbx', 'file-key', 'muted');
// Documents.
add('md mdx markdown rst adoc', 'file-text', 'blue');
add('txt log', 'file-text', 'muted');
add('pdf', 'file-text', 'red');
add('doc docx odt rtf', 'file-text', 'blue');
add('xls xlsx ods xlsm', 'file-spreadsheet', 'green');
add('ppt pptx odp', 'file-slides', 'orange');
// Media and fonts.
add('png jpg jpeg gif webp svg ico bmp avif tif tiff heic psd', 'file-image', 'magenta');
add('mp4 mkv mov avi webm wmv flv m4v mpg mpeg', 'file-video', 'purple');
add('mp3 wav flac ogg m4a aac opus wma mid midi', 'file-audio', 'cyan');
add('ttf otf woff woff2 eot', 'file-font', 'muted');
// Archives.
add('zip rar 7z tar gz tgz bz2 xz zst cab iso nupkg', 'file-archive', 'orange');
// Executables and binaries.
add('exe msi msix appx app', 'app', 'accent');
add('dll so dylib lib a o obj wasm pdb class jar', 'file-binary', 'muted');
// .NET projects and solutions.
add('sln slnx csproj fsproj vbproj vcxproj props targets nuspec', 'file-project', 'magenta');

/** Whole names (lowercase) that mean something on their own. */
const BY_NAME: Record<string, FileIconSpec> = {
  'package.json': spec('package', 'green'),
  'cargo.toml': spec('package', 'orange'),
  'go.mod': spec('package', 'cyan'),
  'pyproject.toml': spec('package', 'green'),
  'requirements.txt': spec('package', 'green'),
  'composer.json': spec('package', 'purple'),
  gemfile: spec('package', 'red'),
  'pubspec.yaml': spec('package', 'cyan'),
  'go.sum': spec('file-lock', 'muted'),
  'package-lock.json': spec('file-lock', 'muted'),
  'npm-shrinkwrap.json': spec('file-lock', 'muted'),
  'packages.lock.json': spec('file-lock', 'muted'),
  'pnpm-lock.yaml': spec('file-lock', 'muted'),
  'bun.lockb': spec('file-lock', 'muted'),
  dockerfile: spec('container', 'blue'),
  containerfile: spec('container', 'blue'),
  '.dockerignore': spec('container', 'muted'),
  'docker-compose.yml': spec('container', 'blue'),
  'docker-compose.yaml': spec('container', 'blue'),
  'compose.yml': spec('container', 'blue'),
  'compose.yaml': spec('container', 'blue'),
  '.gitignore': spec('git', 'orange'),
  '.gitattributes': spec('git', 'orange'),
  '.gitmodules': spec('git', 'orange'),
  '.gitkeep': spec('git', 'muted'),
  '.git-blame-ignore-revs': spec('git', 'muted'),
  makefile: spec('file-terminal', 'orange'),
  justfile: spec('file-terminal', 'orange'),
  '.editorconfig': spec('file-cog', 'muted'),
  '.npmrc': spec('file-key', 'muted'),
  '.nvmrc': spec('file-cog', 'muted'),
  '.prettierrc': spec('file-cog', 'muted'),
  '.eslintrc': spec('file-cog', 'muted'),
  'agents.md': spec('agents', 'accent'),
  'claude.md': spec('agents', 'accent'),
  'claude.local.md': spec('agents', 'accent'),
  'gemini.md': spec('agents', 'accent'),
  '.cursorrules': spec('agents', 'accent'),
  'copilot-instructions.md': spec('agents', 'accent'),
};

/** Lowercase name prefixes (before the first dot) for families of files. */
const BY_STEM: Record<string, FileIconSpec> = {
  readme: spec('readme', 'blue'),
  license: spec('file-badge', 'yellow'),
  licence: spec('file-badge', 'yellow'),
  copying: spec('file-badge', 'yellow'),
  changelog: spec('file-text', 'blue'),
  dockerfile: spec('container', 'blue'),
};

/** Tool configs (`vite.config.ts`, `tsconfig.app.json`, `.eslintrc.cjs`…). */
const CONFIG = /^(?:tsconfig|jsconfig)(?:\..+)?\.json$|\.config\.[cm]?[jt]s$|^\.(?:eslintrc|prettierrc|babelrc|stylelintrc|swcrc)(?:\..+)?$/;

/** The icon of a file by its name. */
export function fileIcon(name: string, link = false): FileIconSpec {
  if (link) return spec('file-symlink', 'muted');
  const lower = name.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return byName;
  // .env, .env.local, .env.production: secrets.
  if (lower === '.env' || lower.startsWith('.env.')) return spec('file-key', 'yellow');
  if (lower.endsWith('.lock')) return spec('file-lock', 'muted');
  if (lower.endsWith('.dockerfile')) return spec('container', 'blue');
  if (CONFIG.test(lower)) return spec('file-cog', 'blue');
  const stem = lower.split('.')[0] ?? '';
  const byStem = stem ? BY_STEM[stem] : undefined;
  if (byStem) return byStem;
  const dot = lower.lastIndexOf('.');
  if (dot > 0 || (dot === 0 && lower.length > 1)) {
    const byExt = BY_EXTENSION[lower.slice(dot + 1)];
    if (byExt) return byExt;
  }
  return spec('file', 'muted');
}

/** Folders worth telling apart (lowercase names), without making the tree loud. */
const FOLDERS: Record<string, FileIconSpec> = {
  src: spec('folder-code', 'folder'),
  source: spec('folder-code', 'folder'),
  lib: spec('folder-code', 'folder'),
  app: spec('folder-code', 'folder'),
  test: spec('folder-tests', 'green'),
  tests: spec('folder-tests', 'green'),
  __tests__: spec('folder-tests', 'green'),
  spec: spec('folder-tests', 'green'),
  e2e: spec('folder-tests', 'green'),
  node_modules: spec('folder-modules', 'muted'),
  vendor: spec('folder-modules', 'muted'),
  '.git': spec('folder-git', 'orange'),
  '.github': spec('folder-git', 'muted'),
  '.vscode': spec('folder-config', 'muted'),
  '.idea': spec('folder-config', 'muted'),
  '.claude': spec('folder-config', 'muted'),
  '.config': spec('folder-config', 'muted'),
  docs: spec('folder-docs', 'folder'),
  doc: spec('folder-docs', 'folder'),
  dist: spec('folder-output', 'muted'),
  build: spec('folder-output', 'muted'),
  out: spec('folder-output', 'muted'),
  target: spec('folder-output', 'muted'),
  bin: spec('folder-output', 'muted'),
  obj: spec('folder-output', 'muted'),
};

/** The icon of a folder: a known one keeps its icon open or closed (the chevron says which). */
export function folderIcon(name: string, open: boolean, link = false): FileIconSpec {
  if (link) return spec('folder-symlink', 'folder');
  return FOLDERS[name.toLowerCase()] ?? spec(open ? 'folder-open' : 'folder', 'folder');
}
