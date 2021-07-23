# native-esm-transform

Aims to make NPM-packages that include a ESM-bundle usable as native ESM-modules by copying files around and transforming paths.  
Exposes a NPM-“bin”-thingy and can therefore be run directly as `native-esm-transform`-command from NPM-scripts.

Configure using a `.native-esm.js`-file in the directory:

```
export const entryPaths = [
  // entry file which is *not* in your src-directory;
  // should be the entry file to a
  // “ready to execute” JS file structure
  // (e.g. coming from the TypeScript compiler)
  'build/app/index.js',
  
  // multiple entry files can be specified,
  // e.g. for a ServiceWorker \o/
  'build/sw/index.js',
];

// this specifies the mapping between
// source paths and destination paths
// this means imports from within `node_modules`
// get copied over to `dist/lib`, mirroring the rest of
// the directory structure;
// this means we can simply expose the `dist`-directory
// using a web server and are good to go
export const rootMap = {
  build: 'dist',
  node_modules: 'dist/lib',
};
```

This is only a proof of concept. Use at your own risk.
