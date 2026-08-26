/**
 * The marker contract between this repo and the out-of-tree update script.
 *
 * `~/.omp/ultracode-update.sh` (`verify_markers`) decides "does this freshly
 * built bundle carry ultracode?" by grepping the strings in
 * `scripts/ultracode-markers.txt`, and refuses to apply the build when any is
 * missing. If a marker stops existing in `src/`, that install-time gate rejects
 * a bundle that is actually fine, with a message claiming the feature is
 * missing. (The fish wrapper is NOT a consumer: it gates on launcher-symlink +
 * VERSION only and deliberately has no self-heal, so a stale marker can only
 * refuse an update — never loop a reapply.)
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
const TESTS_FILE = path.join(PKG_ROOT, "scripts/ultracode-tests.txt");

/** Parse the marker list the installer reads: one per line, `#` comments and blanks dropped. */
async function readMarkers(): Promise<string[]> {
	const raw = await fs.readFile(MARKERS_FILE, "utf8");
	return raw
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith("#"));
}

/** Parse the installer's test list, same one-per-line format as the markers. */
async function readTestList(): Promise<string[]> {
	const raw = await fs.readFile(TESTS_FILE, "utf8");
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
		// bundle carrying the feature from a pristine stock one, so the update
		// script's install-time verify_markers gate would pass a build the rebase
		// had silently reverted.
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

/**
 * The other half of the update-script contract: which tests must pass before
 * `~/.omp/ultracode-update.sh` will apply a freshly built bundle.
 *
 * The marker list proves strings survived bundling. It does not prove the feature
 * works -- and after the v17.3.2 rebase that difference cost real breakage: all
 * three markers were present while 15 tests were failing, because upstream changed
 * `createMagicKeywordSession` from taking a temp-dir path to taking a
 * `ModelRegistry` and the fork's added tests still passed the old argument.
 */
describe("ultracode installer test contract", () => {
	it("lists at least one test file, so an empty list cannot pass as a green gate", async () => {
		const tests = await readTestList();
		expect(tests.length).toBeGreaterThan(0);
	});

	it("points every listed path at a file that exists", async () => {
		const tests = await readTestList();
		const missing: string[] = [];
		for (const rel of tests) {
			const exists = await fs
				.stat(path.join(PKG_ROOT, rel))
				.then(() => true)
				.catch(() => false);
			if (!exists) missing.push(rel);
		}
		// A renamed or deleted test file otherwise turns the gate into a no-op:
		// `bun test` on a path that does not exist is not a failure worth trusting.
		expect(missing).toEqual([]);
	});

	it("covers every ultracode-named test file, so adding one cannot shrink the gate", async () => {
		const tests = new Set(await readTestList());
		const glob = new Bun.Glob("test/**/*ultracode*.test.ts");
		const found: string[] = [];
		for await (const rel of glob.scan({ cwd: PKG_ROOT })) found.push(rel);
		// Guard the guard: a glob that suddenly matches nothing would make the
		// subset check below vacuously true.
		expect(found.length).toBeGreaterThan(0);
		expect(found.filter(rel => !tests.has(rel))).toEqual([]);
	});

	it("pins the gate files whose names do not say ultracode, so deleting one from the list goes red", async () => {
		// The glob check above re-derives only ultracode-NAMED files; these three
		// carry the keyword-firing, session-lifecycle, and plan-review coverage
		// and would otherwise drop out of the gate without any test noticing.
		const pinned = [
			"test/agent-session-magic-keywords.test.ts",
			"test/modes/magic-keywords.test.ts",
			"test/interactive-mode-plan-review.test.ts",
		];
		const listed = new Set(await readTestList());
		expect(pinned.filter(rel => !listed.has(rel))).toEqual([]);
		// Each pinned file must still exercise the feature: one that no longer
		// mentions ultracode is renamed coverage or dead weight, and this pin
		// should be re-decided rather than silently kept.
		const unrelated: string[] = [];
		for (const rel of pinned) {
			const text = await fs.readFile(path.join(PKG_ROOT, rel), "utf8");
			if (!/ultracode/i.test(text)) unrelated.push(rel);
		}
		expect(unrelated).toEqual([]);
	});
});
