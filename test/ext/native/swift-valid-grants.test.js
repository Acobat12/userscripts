import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
	const swiftFiles = [
		new URL("../../../xcode/Ext-Safari/Functions.swift", import.meta.url),
		new URL("../../../userscripts/xcode/Ext-Safari/Functions.swift", import.meta.url),
	];

	for (const swiftFile of swiftFiles) {
		const source = await readFile(swiftFile, "utf8");
		const actual = parseSwiftValidGrants(source);
		assert.deepEqual(
			actual,
			expected,
			`Swift validGrants mismatch in ${swiftFile.pathname}`,
		);
	}
});
