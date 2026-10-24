{
  description = "Lost&Found";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      devShells.default = pkgs.mkShell {
        packages = with pkgs; [
          python312
          uv
          git
        ];

        env = {
          UV_PYTHON_DOWNLOADS = "never";
          UV_PYTHON = "${pkgs.python312}/bin/python3.12";
        };

        shellHook = ''
          echo "syncing uv dependencies..."
          uv sync

          source .venv/bin/activate

          export PATH="$HOME/.local/bin:$PATH"

          echo "dev shell ready"
          echo "  python: $(python --version)"
          echo "  uv:     $(uv --version)"
          echo ""
        '';
      };
    });
}
