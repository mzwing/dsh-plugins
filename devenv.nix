{
  config,
  inputs,
  lib,
  pkgs,
  ...
}: {
  overlays = [inputs.js-toolchain-overlay.overlays.default];

  languages = {
    javascript = {
      enable = true;
      # FIXME: patchelf 0.19.2 leaves node's .dynamic in a read-only segment, so node segfaults on Linux; drop this once nixpkgs ships patchelf 0.19.3 (NixOS/nixpkgs#577387)
      package = pkgs.node-bin.lts.overrideAttrs (old: {
        nativeBuildInputs =
          lib.optional pkgs.stdenv.hostPlatform.isLinux (pkgs.patchelf.overrideAttrs {
            version = "0.15.2";
            src = pkgs.fetchurl {
              url = "https://github.com/NixOS/patchelf/releases/download/0.15.2/patchelf-0.15.2.tar.bz2";
              hash = "sha256-F3RfVkFZyOIo/EEtplogSLhGxLa0Igt3y/IkFuAvLXw=";
            };
          })
          ++ old.nativeBuildInputs;
      });
      nodejs.enable = true;
      pnpm = {
        enable = true;
        package = lib.defaultTo pkgs.pnpm-bin.latest (pkgs.pnpm-bin.fromProject ./.);
      };
      lsp.enable = true;
    };
    typescript = {
      enable = true;
      lsp.enable = true;
    };
  };

  scripts.pnpm-up.exec = let
    major = lib.versions.major config.languages.javascript.pnpm.package.version;
    latestInMajor = pkgs.pnpm-bin.majors.${major};
  in ''
    pnpm pkg set packageManager=pnpm@${latestInMajor.version}
    # The wrapper's pm-on-fail=ignore skips recording the pin in pnpm-lock.yaml; running the pinned version avoids pnpm downloading itself
    ${lib.getExe latestInMajor} install --lockfile-only --pm-on-fail=download
  '';

  enterTest = ''
    node --version
    pnpm --version
  '';
}
