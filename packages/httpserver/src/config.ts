import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the `pi-coding-agent` bin from the installed dependency by ascending from its entry
 * module to the owning `package.json`. Returns undefined when the package is not installed.
 */
function resolvePublishedPiBin(): string | undefined {
	try {
		const require = createRequire(import.meta.url);
		let directory = dirname(require.resolve("@earendil-works/pi-coding-agent"));
		for (let depth = 0; depth < 8; depth += 1) {
			try {
				const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
					name?: string;
					bin?: string | Record<string, string>;
				};
				if (manifest.name === "@earendil-works/pi-coding-agent") {
					const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
					const resolved = bin ? join(directory, bin) : undefined;
					return resolved && existsSync(resolved) ? resolved : undefined;
				}
			} catch {
				// Not a package root; keep ascending.
			}
			const parent = dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	} catch {
		// Dependency is not installed; caller falls back to PATH.
	}
	return undefined;
}

/**
 * Detect the dev launcher of a source checkout.
 *
 * Sits three levels above this module in both `src/` and `dist/` (`packages/httpserver/<dir>/config.*`).
 */
function resolveSourceCheckoutPiBin(): string | undefined {
	try {
		const candidate = fileURLToPath(new URL("../../../pi-test.sh", import.meta.url));
		return existsSync(candidate) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Decide which executable to spawn in RPC mode.
 *
 * Precedence: explicit option, `PI_HTTP_PI_BIN`, the installed `pi-coding-agent` bin, the
 * `pi-test.sh` dev launcher of a source checkout, then `pi` on PATH.
 */
export function resolvePiBin(configured: string | undefined): string {
	const explicit = configured?.trim() || process.env.PI_HTTP_PI_BIN?.trim();
	if (explicit) return explicit;
	return resolvePublishedPiBin() ?? resolveSourceCheckoutPiBin() ?? "pi";
}
