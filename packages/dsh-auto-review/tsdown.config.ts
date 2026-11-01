import type { UserConfig } from 'tsdown'
import { defineConfig } from 'tsdown'

const config: UserConfig = defineConfig({
  clean: true,
  dts: true,
  entry: ['src/index.ts'],
  fixedExtension: false,
  format: 'esm',
  minify: false,
  platform: 'node',
  sourcemap: true,
  target: 'node24',
})

export default config
