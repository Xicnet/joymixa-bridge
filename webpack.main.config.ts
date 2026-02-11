import type { Configuration } from 'webpack';

import { rules } from './webpack.rules';
import { plugins } from './webpack.plugins';

export const mainConfig: Configuration = {
  entry: './src/index.ts',
  module: {
    rules,
  },
  plugins,
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
  },
  // Native addon uses `bindings` to locate .node files at runtime —
  // webpack breaks this by changing __dirname. Externalize it so
  // Electron's require() loads it directly from node_modules.
  externals: {
    '@ktamas77/abletonlink': 'commonjs2 @ktamas77/abletonlink',
  },
};
