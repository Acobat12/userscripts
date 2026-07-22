import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validGrants as sharedValidGrants } from "../../../src/ext/shared/utils.js";

function parseSwiftValidGrants(source) {
	const match = source.match(/let validGrants: Set<String> = \[(?<body>[\s\S]*?)\]/);
	assert.ok(match?.groups?.body, "Swift validGrants block not found");
	return Array.from(
		match.groups.body.matchAll(/"([^"]+)"/g),
		(entry) => entry[1],
	).sort();
}

test("Swift native grant allowlists stay aligned with shared JS grants", async () => {
	const expected = [...sharedValidGrants]
		.filter((grant) => grant !== "none")
		.sort();
	const repoRoot = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"..",
	);
	const swiftFiles = [
		path.join(repoRoot, "xcode", "Ext-Safari", "Functions.swift"),
		path.join(repoRoot, "userscripts", "xcode", "Ext-Safari", "Functions.swift"),
		path.join(repoRoot, " userscripts", "xcode", "Ext-Safari", "Functions.swift"),
	];

	for (const swiftFile of swiftFiles) {
		try {
			await access(swiftFile);
		} catch {
			continue;
		}
		const source = await readFile(swiftFile, "utf8");
		const actual = parseSwiftValidGrants(source);
		assert.deepEqual(
			actual,
			expected,
			`Swift validGrants mismatch in ${swiftFile}`,
		);
	}
});
