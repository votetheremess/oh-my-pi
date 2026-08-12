/**
 * The marker contract between this repo and the out-of-tree installer.
 *
 * `~/.omp/omp-sync.sh` decides "does this bundle carry ultracode?" by grepping
 * the strings in `scripts/ultracode-markers.txt`. If a marker stops existing in
 * `src/`, the installer refuses to install a bundle that is actually fine, with a
 * message claiming the feature is missing -- and the shell wrapper's self-heal
 * reapplies the patch on every single invocation because it also thinks the
 * bundle reverted. Both failures point at the wrong thing.
 *
 * That is not hypothetical: the original markers were two prose sentences inside
 * `ultracode-notice.md`, and a rewrite of that prose came one line away from
 * breaking installation. These tests make the marker list load-bearing HERE,
 * where the strings are authored, instead of only in a shell script nobody runs
 * until update day.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const PKG_ROOT = path.resolve(import.meta.dir, "..");
const MARKERS_FILE = path.join(PKG_ROOT, "scripts/ultracode-markers.txt");

/** Parse the marker list the installer reads: one per line, `#` comments and blanks dropped. */
async function readMarkers(): Promise<string[]> {
	const raw = await fs.readFile(MARKERS_FILE, "utf8");
	return raw
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith("#"));
}

/**
 * Every tracked source file the bundler can pull a string literal from.
 *
 * Comment lines are stripped from TypeScript first, because the bundler strips
 * them too: a marker that survives only inside a doc comment is present in `src/`
 * and ABSENT from the shipped bundle, so a test searching raw source would pass
 * while the installer refused to install. That exact false pass happened here --
 * `agent-session.ts` names the plan-review option in a doc comment, which masked
 * a renamed constant. Markdown and text files are embedded wholesale via
 * `with { type: "text" }`, so they are searched verbatim.
 */
async function sourceTexts(): Promise<Map<string, string>> {
	const glob = new Bun.Glob("src/**/*.{ts,tsx,md,txt}");
	const texts = new Map<string, string>();
	for await (const rel of glob.scan({ cwd: PKG_ROOT })) {
		const raw = await fs.readFile(path.join(PKG_ROOT, rel), "utf8");
		const searchable =
			rel.endsWith(".ts") || rel.endsWith(".tsx")
				? raw
						.split("\n")
						.filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
						.join("\n")
				: raw;
		texts.set(rel, searchable);
	}
	return texts;
}

describe("ultracode installer marker contract", () => {
	it("lists at least two markers, so one rename cannot silently pass", async () => {
		const markers = await readMarkers();
		expect(markers.length).toBeGreaterThanOrEqual(2);
	});

	it("finds every marker in src/, because the installer greps for them", async () => {
		const markers = await readMarkers();
		const texts = await sourceTexts();
		const missing = markers.filter(marker => ![...texts.values()].some(text => text.includes(marker)));
		expect(missing).toEqual([]);
	});

	it("keeps every marker unique to the ultracode feature", async () => {
		// A marker that also appears in stock upstream code cannot distinguish a
		// patched bundle from a pristine one, so the self-heal would never fire.
		const markers = await readMarkers();
		const texts = await sourceTexts();
		for (const marker of markers) {
			const owners = [...texts.entries()]
				.filter(([, text]) => text.includes(marker))
				.map(([rel]) => rel)
				.filter(rel => !rel.includes("ultracode"));
			// Non-ultracode files may reference a marker (settings-schema declares the
			// setting, queued-messages registers the customType, interactive-mode owns
			// the plan option) -- but every such file must be one this branch touches.
			for (const owner of owners) {
				const text = texts.get(owner) ?? "";
				expect(text.toLowerCase()).toContain("ultracode");
			}
		}
	});

	it("uses identifiers rather than prose, which is what broke before", async () => {
		const markers = await readMarkers();
		for (const marker of markers) {
			// Prose markers die to ordinary copy edits. Identifier-shaped markers
			// (settings paths, customTypes, UI labels) change only when the feature does.
			// Heuristic: real prose runs long and ends in sentence punctuation.
			expect(marker.length).toBeLessThanOrEqual(48);
			expect(marker).not.toMatch(/[.!?]$/);
		}
	});
});
