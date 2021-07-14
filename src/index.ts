#!/usr/bin/env node --use_strict --experimental-modules --experimental-import-meta-resolve

import { dirname, relative, resolve } from 'path';
import { init, parse } from 'es-module-lexer';
import { readFile, stat, writeFile } from 'fs/promises';
import { pathToFileURL } from 'url';

const handled = new Set<string>();

const rewriteModulePath = async (
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

const resolveModulePath = async (
  parentPath: string,
  importIdentifier: string
) => {
  const parentUrl = pathToFileURL(parentPath).href;

  const targetPath = new URL(
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    await import.meta.resolve(importIdentifier, parentUrl)
  ).pathname;

  if (!targetPath.includes('/')) return null;

  return targetPath;
};

const transformFile = async (
  pathBoundary: string,
  path: string,
  write: boolean
) => {
  if (!path.startsWith(pathBoundary)) return;

  if (handled.has(path)) return;
  handled.add(path);

  const stats = await stat(path);
  if (!stats.isFile()) return;

  let src = await readFile(path, { encoding: 'utf8' });
  const [imports] = parse(src);

  /* eslint-disable no-await-in-loop */
  for (const importSpecifier of imports) {
    const { n: oldImportIdentifier } = importSpecifier;

    if (!oldImportIdentifier) continue;

    const modulePath = await resolveModulePath(path, oldImportIdentifier);
    if (!modulePath) continue;

    const relativePath = relative(dirname(path), modulePath);
    const newModuleIdentifier = relativePath.startsWith('.')
      ? relativePath
      : `./${relativePath}`;

    src = await rewriteModulePath(
      src,
      oldImportIdentifier,
      newModuleIdentifier
    );

    await transformFile(pathBoundary, modulePath, write);
  }
  /* eslint-enable no-await-in-loop */

  if (write) {
    await writeFile(path, src);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`// ${path}\n${src}\n\n`);
};

export async function transformTree(
  pathBoundary: string,
  path: string,
  write: boolean
): Promise<void> {
  await init;

  const _pathBoundary = resolve(pathBoundary);

  const stats = await stat(_pathBoundary);
  if (!stats.isDirectory()) return;

  await transformFile(_pathBoundary, resolve(path), write);
}

export default transformTree;

(() => {
  const [, , pathBoundary, path, _write] = process.argv;

  const write = Boolean(Number(_write));

  if (pathBoundary && path) {
    transformTree(pathBoundary, path, write);
  }
})();
