#!/usr/bin/env node --use_strict --experimental-modules --experimental-import-meta-resolve

import { ImportSpecifier, init, parse } from 'es-module-lexer';
import { dirname, join, relative, resolve } from 'path';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { pathToFileURL } from 'url';

type RootMap = {
  dist: string;
  src: string;
}[];

type Config = {
  entryPaths: string[];
  rootMap: Record<string, string>;
};

type ResolvedConfig = {
  entryPaths: string[];
  rootMap: RootMap;
};

const handled = new Set<string>();

let config: ResolvedConfig | undefined;

function resolveConfig(cwd: string, input: Config) {
  const { entryPaths: _entryPaths, rootMap: _rootMap } = input;

  const rootMap = Object.entries(_rootMap).map(([srcRoot, distRoot]) => ({
    dist: resolve(cwd, distRoot),
    src: resolve(cwd, srcRoot),
  }));

  const entryPaths = _entryPaths
    .map((entryPath) => resolve(cwd, entryPath))
    .filter((entryPath) =>
      rootMap.find(({ src }) => entryPath.startsWith(src))
    );

  return {
    entryPaths,
    rootMap,
  };
}

function isBareIdentifier(identifier: string) {
  if (identifier.startsWith('../')) return false;
  if (identifier.startsWith('./')) return false;
  if (identifier.startsWith('/')) return false;

  return true;
}

const resolveBareImportPath = async (importIdentifier: string, cdw: string) => {
  const cwdUrl = pathToFileURL(cdw).href;

  const targetPath = new URL(
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    await import.meta.resolve(importIdentifier, cwdUrl)
  ).pathname;

  if (!targetPath.startsWith('/')) return null;

  return targetPath;
};

const rewriteImportPath = async (
  src: string,
  oldImportIdentifier: string,
  newImportIdentifier: string
) => {
  const [imports] = parse(src);

  const importSpecifier = imports.find(({ n }) => n === oldImportIdentifier);
  if (!importSpecifier) return src;

  const { e, s } = importSpecifier;

  return `${src.slice(0, s)}${newImportIdentifier}${src.slice(e)}`;
};

async function handleImport(
  importSpecifier: ImportSpecifier,
  absoluteSrcPath: string,
  absoluteDistPath: string,
  src: string
) {
  const absoluteSrcDir = dirname(absoluteSrcPath);
  const absoluteDistDir = dirname(absoluteDistPath);

  const { n: importIdentifier } = importSpecifier;
  if (!importIdentifier) return null;

  const bare = isBareIdentifier(importIdentifier);

  const absoluteImportSrcPath = bare
    ? await resolveBareImportPath(importIdentifier, absoluteSrcPath)
    : resolve(absoluteSrcDir, importIdentifier);
  if (!absoluteImportSrcPath) return null;

  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  const absoluteImportDistPath = await handleFile(absoluteImportSrcPath);

  const resolvedImportIdentifier = (() => {
    const path = relative(absoluteDistDir, absoluteImportDistPath);

    return isBareIdentifier(path) ? `./${path}` : path;
  })();

  return rewriteImportPath(src, importIdentifier, resolvedImportIdentifier);
}

async function handleFile(absoluteSrcPath: string) {
  const { rootMap } = config as ResolvedConfig;

  const matchingRoot = rootMap.find(({ src }) =>
    absoluteSrcPath.startsWith(src)
  );
  if (!matchingRoot) {
    throw new Error(`no matching root for this src file (${absoluteSrcPath})`);
  }

  const { dist: distRoot, src: srcRoot } = matchingRoot;

  const relativeSrcPath = relative(srcRoot, absoluteSrcPath);
  const absoluteDistPath = resolve(distRoot, relativeSrcPath);

  if (handled.has(absoluteDistPath)) return absoluteDistPath;

  const stats = await stat(absoluteSrcPath);
  if (!stats.isFile()) {
    throw new Error(`cannot read src file (${absoluteSrcPath})`);
  }

  let src = await readFile(absoluteSrcPath, { encoding: 'utf8' });
  handled.add(absoluteDistPath);

  const [imports] = parse(src);

  for (const importSpecifier of imports) {
    // eslint-disable-next-line no-await-in-loop
    const amendedSrc = await handleImport(
      importSpecifier,
      absoluteSrcPath,
      absoluteDistPath,
      src
    );

    src = amendedSrc || src;
  }

  const absoluteDistDir = dirname(absoluteDistPath);

  await mkdir(absoluteDistDir, { recursive: true });
  await writeFile(absoluteDistPath, src);

  return absoluteDistPath;
}

(async () => {
  await init;

  const cwd = process.cwd();

  const _config = await (async () => {
    try {
      return (await import(join(cwd, '.native-esm.js'))) as Config;
    } catch {
      return {
        entryPaths: [] as string[],
        rootMap: {} as Record<string, string>,
      };
    }
  })();

  config = resolveConfig(cwd, _config);
  const { entryPaths } = config;

  for (const entryPath of entryPaths) {
    handleFile(entryPath);
  }
})();
