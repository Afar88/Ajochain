import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // Keep heavy protocol libraries cacheable, but don't force each
            // entire package into one oversized vendor file.
            { name: 'cashscript-vendor', test: /node_modules[\\/]cashscript[\\/]/, maxSize: 450000, priority: 40 },
            { name: 'libauth-vendor', test: /node_modules[\\/]@bitauth[\\/]libauth[\\/]/, maxSize: 450000, priority: 35 },
            { name: 'electrum-vendor', test: /node_modules[\\/]@electrum-cash[\\/]/, priority: 30 },
            { name: 'wallet-vendor', test: /node_modules[\\/]@wizardconnect[\\/]/, priority: 25 },
            { name: 'qrcode-vendor', test: /node_modules[\\/]qrcode[\\/]/, priority: 20 },
            { name: 'shared-vendor', test: /node_modules[\\/]/, minShareCount: 2, minSize: 20000, priority: 10 },
          ],
        },
      },
    },
  },
  server: { fs: { allow: ['..'] } },
});
