import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(viteConfig, defineConfig({
  test: {
    include: ['test/**/*.{test,spec}.{ts,tsx,js,jsx}'],
    benchmark: { include: ['test/**/*.bench.{ts,tsx,js,jsx}'] },
  },
}));
