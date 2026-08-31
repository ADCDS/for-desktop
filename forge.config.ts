import { MakerAppX } from "@electron-forge/maker-appx";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerFlatpak } from "@electron-forge/maker-flatpak";
import { MakerFlatpakOptionsConfig } from "@electron-forge/maker-flatpak/dist/Config";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { PublisherGithub } from "@electron-forge/publisher-github";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import fs from "node:fs";
import path from "node:path";

// import { globSync } from "node:fs";

const STRINGS = {
  author: "Revolt Platforms LTD",
  name: "Stoat",
  execName: "stoat-desktop",
  description: "Open source user-first chat platform.",
};

const ASSET_DIR = "assets/desktop";

/**
 * Build targets for the desktop app
 */
const makers: ForgeConfig["makers"] = [
  new MakerSquirrel({
    name: STRINGS.name,
    authors: STRINGS.author,
    // todo: hoist this
    iconUrl: `https://stoat.chat/app/assets/icon-DUSNE-Pb.ico`,
    // todo: loadingGif
    setupIcon: `${ASSET_DIR}/icon.ico`,
    description: STRINGS.description,
    exe: `${STRINGS.execName}.exe`,
    setupExe: `${STRINGS.execName}-setup.exe`,
    copyright: "Copyright (C) 2025 Revolt Platforms LTD",
  }),
  new MakerZIP({}),
  // darwin only: appdmg needs macOS `hdiutil`, so this can only run on a Mac
  // (or a macos GitHub runner) -- it cannot be cross-compiled from Linux.
  new MakerDMG({ overwrite: true }, ["darwin"]),
  new MakerFlatpak({
    options: {
      id: "chat.stoat.StoatDesktop",
      description: STRINGS.description,
      productName: STRINGS.name,
      productDescription: STRINGS.description,
      runtimeVersion: "25.08",
      icon: {
        "16x16": `${ASSET_DIR}/hicolor/16x16.png`,
        "32x32": `${ASSET_DIR}/hicolor/32x32.png`,
        "64x64": `${ASSET_DIR}/hicolor/64x64.png`,
        "128x128": `${ASSET_DIR}/hicolor/128x128.png`,
        "256x256": `${ASSET_DIR}/hicolor/256x256.png`,
        "512x512": `${ASSET_DIR}/hicolor/512x512.png`,
      } as unknown,
      categories: ["Network"],
      modules: [
        // use the latest zypak -- Electron sandboxing for Flatpak
        {
          name: "zypak",
          sources: [
            {
              type: "git",
              url: "https://github.com/refi64/zypak",
              tag: "v2025.09",
            },
          ],
        },
      ],
      finishArgs: [
        // default arguments found by running
        // DEBUG=electron-installer-flatpak* pnpm make
        "--socket=fallback-x11",
        "--socket=wayland",
        "--share=ipc",
        "--share=network",
        "--device=dri",
        "--device=all",
        "--socket=pulseaudio",
        "--filesystem=xdg-run/pipewire-0",
        "--filesystem=xdg-videos:ro",
        "--filesystem=xdg-pictures:ro",
        "--filesystem=xdg-download",
        "--filesystem=xdg-run/speech-dispatcher",
        "--talk-name=org.freedesktop.ScreenSaver",
        "--talk-name=org.freedesktop.Notifications",
        "--talk-name=org.kde.StatusNotifierWatcher",
        "--talk-name=com.canonical.AppMenu.Registrar",
        "--talk-name=com.canonical.indicator.application",
        "--talk-name=com.canonical.Unity",
        "--env=XCURSOR_PATH=/run/host/user-share/icons:/run/host/share/icons",
        "--env=ELECTRON_TRASH=gio",
        "--env=TMPDIR=xdg-run/app/chat.stoat.StoatDesktop",
      ],
      files: [],
    } as MakerFlatpakOptionsConfig,
  }),
];

// skip these makers in CI/CD
if (!process.env.PLATFORM) {
  makers.push(
    // must be manually built (freezes CI process)
    // not much use in being published anyhow
    new MakerAppX({
      certPass: "",
      packageExecutable: `app\\${STRINGS.execName}.exe`,
      publisher: "CN=B040CC7E-0016-4AF5-957F-F8977A6CFA3B",
    }),
    // testing purposes
    new MakerDeb({
      options: {
        productName: STRINGS.name,
        productDescription: STRINGS.description,
        categories: ["Network"],
        icon: `${ASSET_DIR}/icon.png`,
      },
    }),
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: STRINGS.name,
    executableName: STRINGS.execName,
    icon:
      process.platform === "darwin"
        ? `${ASSET_DIR}/icon.icon`
        : `${ASSET_DIR}/icon`,
    // macOS signing. There is no Developer ID and there will not be one, so
    // notarization is impossible and Gatekeeper always wants a one-time
    // "Open Anyway" (or xattr -dr com.apple.quarantine).
    //
    // What has to hold regardless is that the bundle gets a real *resource
    // seal*. Up to v1.5.3-adriel.1 it did not: identity "-" went to
    // @electron/osx-sign with identityValidation left on, `security
    // find-identity -v` matched nothing, osx-sign threw "No identity found for
    // signing", and @electron/packager swallowed it -- createSignOpts defaults
    // continueOnError to true, so signAppIfSpecified downgrades the throw to a
    // warning that forge's spinner hides. Every macOS build since shipped with
    // just the linker's ad-hoc signature and no CodeResources, which arm64
    // rejects outright as "damaged". See issue #1.
    //
    // MACOS_SIGN_IDENTITY, when set, names a self-signed cert in the runner's
    // keychain. It buys no Gatekeeper trust -- only a *stable* designated
    // requirement, so TCC keeps the user's Accessibility grant (global
    // push-to-talk) across updates instead of orphaning it every release the
    // way an ad-hoc cdhash does. Unset, we still sign ad-hoc: that fixes
    // "damaged" but not the permission churn.
    //
    // This must stay truthy on darwin. With no osxSign config, FusesPlugin
    // flips resetAdHocDarwinSignature and signs only the main executable,
    // leaving the bundle unsealed all over again.
    osxSign: (process.platform === "darwin"
      ? {
          identity: process.env.MACOS_SIGN_IDENTITY || "-",
          // skip `security find-identity -v`, which filters out both "-" and a
          // self-signed cert that is not (yet) trusted on the build machine
          identityValidation: false,
          ...(process.env.MACOS_SIGN_KEYCHAIN
            ? { keychain: process.env.MACOS_SIGN_KEYCHAIN }
            : {}),
          // packager reads this but omits it from its exported OsxSignOptions
          // type, hence the cast. Without it a signing failure is a warning.
          continueOnError: false,
          // osx-sign would otherwise try to derive an Apple Team ID from the
          // certificate to synthesise entitlements. Ours has none.
          preAutoEntitlements: false,
          optionsForFile: () => ({
            entitlements: "./entitlements.plist",
            // osx-sign defaults this to true (sign.js getDefaultOptionsForFile).
            // Hardened runtime is only a notarization prerequisite, and turning
            // it on without com.apple.security.cs.allow-jit and
            // allow-unsigned-executable-memory -- neither of which is in
            // entitlements.plist -- makes V8 SIGKILL at launch. If a Developer
            // ID ever appears, add those entitlements *before* flipping this.
            hardenedRuntime: false,
            // Unset means osx-sign passes a bare `--timestamp`, which demands a
            // round trip to timestamp.apple.com for every one of ~200 signed
            // files and fails outright for an ad-hoc identity.
            timestamp: "none",
          }),
        }
      : undefined) as ForgeConfig["packagerConfig"]["osxSign"],

    // extraResource: [
    //   // include all the asset files
    //   ...globSync(ASSET_DIR + "/**/*"),
    // ],
  },
  rebuildConfig: {},
  makers,
  hooks: {
    // Copy the node-pipewire dist to the app on linux
    packageAfterCopy: async (_config, buildPath, _version, platform, arch) => {
      // uiohook-napi provides global push-to-talk on Windows and macOS. It has
      // to be copied by hand for the same reason node-pipewire does: packager's
      // dependency walk does not follow pnpm's layout, so it gets pruned. Only
      // the prebuild for the target platform is copied -- shipping all seven
      // would add ~1MB of binaries for architectures this build cannot run on.
      const uiohook = "node_modules/uiohook-napi";
      const prebuild = `${platform}-${arch}`;
      if (fs.existsSync(`${uiohook}/prebuilds/${prebuild}`)) {
        for (const file of ["package.json", "dist"]) {
          fs.cpSync(
            `${uiohook}/${file}`,
            path.join(buildPath, uiohook, file),
            { recursive: true },
          );
        }
        fs.cpSync(
          `${uiohook}/prebuilds/${prebuild}`,
          path.join(buildPath, uiohook, "prebuilds", prebuild),
          { recursive: true },
        );
        // uiohook's entrypoint is `require('node-gyp-build')(__dirname/..)`,
        // so the loader has to come along or the require throws
        // MODULE_NOT_FOUND and push-to-talk silently degrades to focused-only.
        // realpath because pnpm may leave this as a symlink into .pnpm, which
        // cpSync would copy as a dangling link.
        fs.cpSync(
          fs.realpathSync("node_modules/node-gyp-build"),
          path.join(buildPath, "node_modules/node-gyp-build"),
          { recursive: true },
        );
      }

      if (platform === "linux") {
        // Copy only the files we need to run the code, which is dist, LICENSE, and package.json
        fs.cpSync(
          "node_modules/node-pipewire/dist",
          path.join(buildPath, "node_modules/node-pipewire/dist"),
          { recursive: true },
        );
        fs.cpSync(
          "node_modules/node-pipewire/LICENSE",
          path.join(buildPath, "node_modules/node-pipewire/LICENSE"),
          { recursive: true },
        );
        fs.cpSync(
          "node_modules/node-pipewire/package.json",
          path.join(buildPath, "node_modules/node-pipewire/package.json"),
          { recursive: true },
        );
      }
    },
  },
  plugins: [
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {},
    },
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
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
  publishers: [
    new PublisherGithub({
      repository: {
        owner: "stoatchat",
        name: "for-desktop",
      },
    }),
  ],
};

export default config;
