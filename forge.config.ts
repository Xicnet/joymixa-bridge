import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import * as path from 'path';
import * as fs from 'fs';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';
import { preloadConfig } from './webpack.preload.config';

// Native modules that webpack externalizes — must be copied into the package
const NATIVE_MODULES = ['@xicnet/abletonlink', 'coreaudio-latency', 'wasapi-latency', 'bindings', 'file-uri-to-path', 'node-addon-api'];

/**
 * Build-time debris that must not ship. At runtime the native modules need only
 * their JS entry, package.json and build/Release/*.node (that is the full search
 * path `bindings` uses here). Everything below is compile-time input or output:
 * the Ableton Link C++ SDK tree (24 MB of sources + asio docs), the addon C++
 * sources, and gyp's intermediate objects (obj.target holds a duplicate .node).
 * GPL source obligations are met by the About-box source offer, not by shipping
 * sources inside the binary.
 */
const NATIVE_MODULE_PRUNE = [
  '@xicnet/abletonlink/link',
  '@xicnet/abletonlink/src',
  '@xicnet/abletonlink/build/Release/obj.target',
  '@xicnet/abletonlink/build/Release/.deps',
  'coreaudio-latency/build/Release/obj.target',
  'coreaudio-latency/build/Release/.deps',
  'wasapi-latency/build/Release/obj.target',
  'wasapi-latency/build/Release/.deps',
];

function copyNativeModules(buildPath: string): void {
  const srcNodeModules = path.resolve(__dirname, 'node_modules');
  const destNodeModules = path.join(buildPath, 'node_modules');

  for (const mod of NATIVE_MODULES) {
    const srcDir = path.join(srcNodeModules, mod);
    const destDir = path.join(destNodeModules, mod);
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, destDir, { recursive: true });
    }
  }
  for (const rel of NATIVE_MODULE_PRUNE) {
    fs.rmSync(path.join(destNodeModules, rel), { recursive: true, force: true });
  }
}

/**
 * Put OUR license at the package root.
 *
 * electron-packager writes Electron's own MIT LICENSE to the root of the packaged
 * app. Joymixa Bridge is GPLv2+ (it links Ableton Link), so a user who unzips the
 * app and opens the obvious file named `LICENSE` would read MIT for a GPLv2+
 * binary. Our GPL text otherwise only reaches the package buried inside
 * `resources/app.asar.unpacked/node_modules/@xicnet/abletonlink/`.
 *
 * Electron's MIT notice is a legitimate third-party notice, so it is preserved —
 * just renamed so it no longer masquerades as the license of this application.
 * `extraResource` cannot do this: it copies into `resources/`, not the root.
 */
function placeLicenses(finalPath: string): void {
  const electronLicense = path.join(finalPath, 'LICENSE');
  if (fs.existsSync(electronLicense)) {
    fs.renameSync(electronLicense, path.join(finalPath, 'LICENSE.electron.txt'));
  }
  fs.copyFileSync(path.resolve(__dirname, 'LICENSE'), path.join(finalPath, 'LICENSE'));
  fs.copyFileSync(
    path.resolve(__dirname, 'THIRD-PARTY-NOTICES.txt'),
    path.join(finalPath, 'THIRD-PARTY-NOTICES.txt'),
  );
}

/**
 * macOS signing + notarization — active only when the CI signing env is present.
 *
 * The gate keeps every other context working unsigned: local dev builds (no cert
 * in any keychain), Linux/Windows CI rows, and forks without the repo secrets.
 * When active:
 *   - `osxSign: {}` — @electron/osx-sign defaults are correct for this app: it
 *     discovers the Developer ID identity in the keychain, signs the unpacked
 *     `.node` addons automatically, and enables the hardened runtime. No extra
 *     entitlements are needed (no JIT-restricted code beyond Electron's own
 *     defaults; the multicast entitlement is iOS-only and does not exist on macOS).
 *   - `osxNotarize` — notarytool via Apple ID + app-specific password; stapling
 *     is automatic.
 */
const macSigning =
  process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID
    ? {
        osxSign: {},
        osxNotarize: {
          appleId: process.env.APPLE_ID,
          appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
          teamId: process.env.APPLE_TEAM_ID,
        },
      }
    : {};

const config: ForgeConfig = {
  packagerConfig: {
    ...macSigning,
    asar: {
      unpack: '**/node_modules/{@xicnet/abletonlink,coreaudio-latency,wasapi-latency,bindings,file-uri-to-path,node-addon-api}/**',
    },
    name: 'Joymixa Bridge',
    executableName: 'joymixa-bridge',
    icon: './assets/icon',

    /**
     * macOS bundle identity.
     *
     * `appBundleId` is REQUIRED to notarize: without it the app ships under Electron's
     * default `com.electron.*` identifier, which Apple will not notarize as ours.
     *
     * Treat this string as permanent. macOS keys the app's identity off it — preferences,
     * keychain entries, and TCC permission grants (including the Local Network permission
     * below) are all bound to it. Changing it later makes macOS see a brand-new app: the
     * user must re-grant Local Network access, and settings are orphaned.
     *
     * The reverse-DNS form is a uniqueness *convention*, not a verification — Apple never
     * checks domain ownership for it. So this string stays valid even if the domain later
     * lapses or the product is renamed. `com.joymixa.*` matches the existing iOS bundle
     * (`com.joymixa.linkbridge`, ios/LinkBridge.xcodeproj), keeping the two Apple platforms
     * consistent. (Android is `com.xicnet.joymixabridge` — already published, so it cannot
     * move; it does not constrain us here.)
     */
    appBundleId: 'com.joymixa.bridge',
    appCategoryType: 'public.app-category.music',

    // Surfaces as NSHumanReadableCopyright on macOS (the Get Info panel) and LegalCopyright
    // on Windows. It was unset, so the shipped bundle claimed no copyright at all while the
    // About box, README and THIRD-PARTY-NOTICES all did. "XicNET" is a trading name and
    // cannot hold copyright; the natural person does.
    appCopyright: 'Copyright (c) 2026 Ramiro Augusto Cosentino (XicNET). GPL-2.0-or-later.',

    extendInfo: {
      /**
       * REQUIRED for Link to work at all on macOS 15+. Ableton Link discovers peers over
       * UDP multicast on the local network; without this key macOS silently denies that
       * access and the bridge reports **zero peers** while otherwise appearing healthy —
       * a functional bug, not merely a signing one.
       *
       * This string is shown VERBATIM to the user in the macOS permission dialog.
       */
      NSLocalNetworkUsageDescription:
        'Joymixa Bridge uses your local network to find and sync with Ableton Link devices.',
    },

    extraResource: [
      './assets/tray-icon.png',
      // macOS menu-bar Template icons (black + alpha); picked on darwin in createTrayIcon()
      './assets/tray-iconTemplate.png',
      './assets/tray-iconTemplate@2x.png',
    ],
    afterCopy: [
      (buildPath, _electronVersion, _platform, _arch, callback) => {
        try {
          copyNativeModules(buildPath);
          callback();
        } catch (err) {
          callback(err as Error);
        }
      },
    ],
    afterComplete: [
      (finalPath, _electronVersion, _platform, _arch, callback) => {
        try {
          placeLicenses(finalPath);
          callback();
        } catch (err) {
          callback(err as Error);
        }
      },
    ],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: 'joymixa-bridge',
    }),
    /**
     * The DMG is what a Mac user expects to download: mount, drag to Applications, done.
     * Until now macOS shipped only a .zip, which unpacks a bare .app into ~/Downloads with
     * no hint that it belongs in /Applications.
     *
     * `@electron-forge/maker-dmg` is macOS-only — *"You can only build the DMG target on
     * macOS machines"* — so it is scoped to darwin here and only listed in the two macOS
     * rows of the CI matrix. The Linux and Windows jobs never invoke it.
     *
     * The .zip stays: Squirrel.Mac consumes a .zip for auto-update, so dropping it would
     * foreclose that route.
     */
    new MakerDMG({}, ['darwin']),
    new MakerZIP({}, ['darwin', 'win32']),
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
