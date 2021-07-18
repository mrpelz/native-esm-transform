#!/usr/bin/env node --use_strict --experimental-modules --experimental-import-meta-resolve
import { parse as esParse, init } from 'es-module-lexer';
import { copyFile, mkdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname, join, parse, relative, resolve } from 'path';
import { pathToFileURL } from 'url';
const handled = new Set();
const packageJsons = new Map();
let config;
function resolveConfig(cwd, input) {
    const { entryPaths: _entryPaths, rootMap: _rootMap } = input;
    const rootMap = Object.entries(_rootMap).map(([srcRoot, distRoot]) => ({
        dist: resolve(cwd, distRoot),
        src: resolve(cwd, srcRoot),
    }));
    const entryPaths = _entryPaths
        .map((entryPath) => resolve(cwd, entryPath))
        .filter((entryPath) => rootMap.find(({ src }) => entryPath.startsWith(src)));
    return {
        entryPaths,
        rootMap,
    };
}
function isBareIdentifier(identifier) {
    if (identifier.startsWith('../'))
        return false;
    if (identifier.startsWith('./'))
        return false;
    if (identifier.startsWith('/'))
        return false;
    return true;
}
async function getPackageJson(absoluteSrcPath) {
    const { rootMap } = config;
    const packageJsonPath = await (async () => {
        let searchDir = dirname(absoluteSrcPath);
        do {
            const path = resolve(searchDir, 'package.json');
            try {
                // eslint-disable-next-line no-await-in-loop
                const stats = await stat(path);
                if (stats.isFile())
                    return path;
            }
            catch {
                // noop
            }
            searchDir = resolve(searchDir, '../');
            // eslint-disable-next-line no-loop-func
        } while (!rootMap.find(({ src }) => src === searchDir));
        return null;
    })();
    if (!packageJsonPath) {
        return {
            content: {},
            path: null,
        };
    }
    const packageJsonSrc = await readFile(packageJsonPath, { encoding: 'utf8' });
    const packageJson = (() => {
        try {
            return JSON.parse(packageJsonSrc);
        }
        catch {
            return {
                content: {},
                path: packageJsonPath,
            };
        }
    })();
    return {
        content: packageJson,
        path: packageJsonPath,
    };
}
function getBundleAlternative(packageJson, absoluteImportPath) {
    const { content, path } = packageJson;
    if (!path || !content)
        return null;
    const absolutePackagePath = dirname(path);
    const { browser, main, module } = content || {};
    if (!main)
        return null;
    const absoluteMainPath = resolve(absolutePackagePath, main);
    const importIsMainEntry = (() => {
        try {
            const { dir: importDir, name: importName } = parse(absoluteImportPath);
            const importBase = join(importDir, importName);
            const { ext, dir: mainDir, name: mainName } = parse(absoluteMainPath);
            const mainBase = join(mainDir, mainName);
            if (!['.js', '.mjs'].includes(ext))
                return false;
            if (importBase !== mainBase)
                return false;
        }
        catch {
            return false;
        }
        return true;
    })();
    const absoluteModulePath = module
        ? resolve(absolutePackagePath, module)
        : null;
    const absoluteBrowserPath = (() => {
        if (importIsMainEntry && typeof browser === 'string') {
            const resolved = resolve(absolutePackagePath, browser);
            return resolved;
        }
        if (typeof browser !== 'object')
            return null;
        if (absoluteModulePath) {
            for (const [key, value] of Object.entries(browser)) {
                const resolvedKey = resolve(absolutePackagePath, key);
                if (resolvedKey !== absoluteModulePath)
                    continue;
                if (typeof value !== 'string')
                    continue;
                const resolvedValue = resolve(absolutePackagePath, value);
                return resolvedValue;
            }
        }
        for (const [key, value] of Object.entries(browser)) {
            const resolvedKey = resolve(absolutePackagePath, key);
            if (resolvedKey !== absoluteImportPath)
                continue;
            if (typeof value !== 'string')
                continue;
            const resolvedValue = resolve(absolutePackagePath, value);
            return resolvedValue;
        }
        return null;
    })();
    return absoluteBrowserPath || absoluteModulePath;
}
async function resolveBareImportPath(importIdentifier, absoluteSrcPath) {
    const absoluteSrcUrl = pathToFileURL(absoluteSrcPath).href;
    const importUrl = new URL(
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    await import.meta.resolve(importIdentifier, absoluteSrcUrl));
    if (importUrl.protocol !== 'file:')
        return null;
    const absoluteImportPath = importUrl.pathname;
    const packageJson = await (async () => {
        const cached = packageJsons.get(absoluteImportPath);
        if (cached)
            return cached;
        const live = await getPackageJson(absoluteImportPath);
        packageJsons.set(absoluteImportPath, live);
        return live;
    })();
    const absoluteBundleAlternative = getBundleAlternative(packageJson, absoluteImportPath);
    return absoluteBundleAlternative || absoluteImportPath;
}
const rewriteImportPath = async (src, oldImportIdentifier, newImportIdentifier) => {
    const [imports] = esParse(src);
    const importSpecifier = imports.find(({ n }) => n === oldImportIdentifier);
    if (!importSpecifier)
        return src;
    const { e, s } = importSpecifier;
    return `${src.slice(0, s)}${newImportIdentifier}${src.slice(e)}`;
};
async function handleImport(importSpecifier, absoluteSrcPath, absoluteDistPath, src) {
    const absoluteSrcDir = dirname(absoluteSrcPath);
    const absoluteDistDir = dirname(absoluteDistPath);
    const { n: importIdentifier } = importSpecifier;
    if (!importIdentifier)
        return null;
    const bare = isBareIdentifier(importIdentifier);
    const absoluteImportSrcPath = bare
        ? await resolveBareImportPath(importIdentifier, absoluteSrcPath)
        : resolve(absoluteSrcDir, importIdentifier);
    if (!absoluteImportSrcPath)
        return null;
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    const absoluteImportDistPath = await handleFile(absoluteImportSrcPath);
    const resolvedImportIdentifier = (() => {
        const path = relative(absoluteDistDir, absoluteImportDistPath);
        return isBareIdentifier(path) ? `./${path}` : path;
    })();
    return rewriteImportPath(src, importIdentifier, resolvedImportIdentifier);
}
async function handleFile(absoluteSrcPath) {
    const { rootMap } = config;
    const matchingRoot = rootMap.find(({ src }) => absoluteSrcPath.startsWith(src));
    if (!matchingRoot) {
        throw new Error(`\n\n\tno matching root for this src file (${absoluteSrcPath})\n\n`);
    }
    const { dist: distRoot, src: srcRoot } = matchingRoot;
    const relativeSrcPath = relative(srcRoot, absoluteSrcPath);
    const absoluteDistPath = resolve(distRoot, relativeSrcPath);
    if (handled.has(absoluteDistPath))
        return absoluteDistPath;
    let src = await (async () => {
        try {
            const stats = await stat(absoluteSrcPath);
            if (!stats.isFile()) {
                throw new Error(`cannot read src file (${absoluteSrcPath})`);
            }
            const result = await readFile(absoluteSrcPath, { encoding: 'utf8' });
            return result;
        }
        catch (error) {
            throw new Error(`error reading file: ${error}`);
        }
    })();
    handled.add(absoluteDistPath);
    const [imports] = esParse(src);
    for (const importSpecifier of imports) {
        // eslint-disable-next-line no-await-in-loop
        const amendedSrc = await handleImport(importSpecifier, absoluteSrcPath, absoluteDistPath, src);
        src = amendedSrc || src;
    }
    const absoluteDistDir = dirname(absoluteDistPath);
    await mkdir(absoluteDistDir, { recursive: true });
    await writeFile(absoluteDistPath, src);
    await (async () => {
        try {
            const srcPath = `${absoluteSrcPath}.map`;
            const distPath = `${absoluteDistPath}.map`;
            const stats = await stat(srcPath);
            if (stats.isFile()) {
                await copyFile(srcPath, distPath);
            }
        }
        catch {
            // noop
        }
    })();
    return absoluteDistPath;
}
(async () => {
    await init;
    const cwd = process.cwd();
    const _config = await (async () => {
        try {
            return (await import(join(cwd, '.native-esm.js')));
        }
        catch {
            return {
                entryPaths: [],
                rootMap: {},
            };
        }
    })();
    config = resolveConfig(cwd, _config);
    const { entryPaths } = config;
    for (const entryPath of entryPaths) {
        handleFile(entryPath);
    }
})();
//# sourceMappingURL=index.js.map