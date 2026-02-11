import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';
import { preloadConfig } from './webpack.preload.config';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'Joymixa Bridge',
    executableName: 'joymixa-bridge',
    icon: './assets/icon',
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: 'joymixa-bridge',
    }),
    new MakerZIP({}, ['darwin']),
    new MakerDeb({
      options: {
        name: 'joymixa-bridge',
        productName: 'Joymixa Bridge',
        genericName: 'Music Sync Bridge',
        description: 'Ableton Link bridge and Joymixa-to-Joymixa relay for LAN music sync',
        categories: ['Audio', 'Music'],
      },
    }),
    new MakerRpm({
      options: {
        name: 'joymixa-bridge',
        productName: 'Joymixa Bridge',
        description: 'Ableton Link bridge and Joymixa-to-Joymixa relay for LAN music sync',
        categories: ['Audio', 'Music'],
      },
    }),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/index.html',
            js: './src/renderer.ts',
            name: 'main_window',
            preload: {
              js: './src/preload.ts',
              config: preloadConfig,
            },
          },
        ],
      },
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
