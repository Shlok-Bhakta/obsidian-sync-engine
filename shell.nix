{pkgs ? import <nixpkgs> {}}:
pkgs.mkShell{
	buildInputs = [
		pkgs.postgresql_18_jit
		pkgs.cloudflared
	];
}
