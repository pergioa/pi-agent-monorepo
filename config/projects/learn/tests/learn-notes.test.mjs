import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	appendGeneratedBlock,
	closeConcept,
	createPendingNotebook,
	currentOutputFile,
	initializeNotebook,
	openConcept,
	safePathSegment,
	setNotebookPlan,
} from "../extensions/learn-notes/core.ts";

function withTempDirectory(run) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "learn-notes-test-"));
	try {
		run(directory);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

test("sanitizes model-derived titles into one safe path segment", () => {
	assert.equal(safePathSegment('../Transformers: "Attention" / Basics'), "Transformers Attention Basics");
	assert.equal(safePathSegment("..."), "Untitled");
});

test("initialization creates only the hub and plan files remain lazy", () => {
	withTempDirectory((cwd) => {
		let state = createPendingNotebook(cwd, "Teach me why attention works", "session-1");
		state = initializeNotebook(state, "Transformer Attention", "Understand attention from first principles");

		assert.ok(state.hubFile);
		assert.equal(fs.existsSync(state.hubFile), true);
		assert.equal(fs.existsSync(path.join(state.rootDirectory, "Concepts")), false);

		state = setNotebookPlan(state, [
			{ id: "tokens", title: "Tokens and Representations" },
			{ id: "attention", title: "Attention", dependsOn: ["tokens"] },
		]);

		assert.equal(fs.existsSync(path.join(state.rootDirectory, "Concepts")), false);
		const hub = fs.readFileSync(state.hubFile, "utf-8");
		assert.match(hub, /Tokens and Representations/);
		assert.match(hub, /N0 --> N1/);
		assert.match(hub, /\[\[Learn\/Transformer Attention\/Concepts\/Attention\|Attention\]\]/);
		assert.ok(hub.indexOf("<!-- learn-notes:index:end -->") < hub.indexOf("## Learning session"));
	});
});

test("opening a concept creates it, routes blocks idempotently, and closing returns to the hub", () => {
	withTempDirectory((cwd) => {
		let state = initializeNotebook(
			createPendingNotebook(cwd, "Teach me networking", "session-2"),
			"Computer Networking",
			"Understand packet delivery",
		);
		state = setNotebookPlan(state, [{ id: "packets", title: "Packets" }]);
		state = openConcept(state, "packets");

		const conceptFile = currentOutputFile(state);
		assert.ok(conceptFile);
		assert.equal(fs.existsSync(conceptFile), true);
		assert.equal(appendGeneratedBlock(conceptFile, "entry-1", "First explanation"), true);
		assert.equal(appendGeneratedBlock(conceptFile, "entry-1", "Duplicate explanation"), false);
		assert.doesNotMatch(fs.readFileSync(conceptFile, "utf-8"), /Duplicate explanation/);

		state = closeConcept(state);
		assert.equal(currentOutputFile(state), state.hubFile);
		assert.match(fs.readFileSync(conceptFile, "utf-8"), /Status: complete/);
	});
});

test("a repeated derived title never overwrites an existing notebook", () => {
	withTempDirectory((cwd) => {
		const first = initializeNotebook(
			createPendingNotebook(cwd, "First", "session-1"),
			"Linear Algebra",
			"First goal",
		);
		const second = initializeNotebook(
			createPendingNotebook(cwd, "Second", "session-2"),
			"Linear Algebra",
			"Second goal",
		);
		assert.notEqual(first.rootDirectory, second.rootDirectory);
		assert.equal(fs.existsSync(first.hubFile), true);
		assert.equal(fs.existsSync(second.hubFile), true);
	});
});

test("rejects invalid dependency graphs before updating the hub", () => {
	withTempDirectory((cwd) => {
		const state = initializeNotebook(
			createPendingNotebook(cwd, "Teach me cycles", "session-3"),
			"Dependency Graphs",
			"Understand DAGs",
		);
		assert.throws(
			() => setNotebookPlan(state, [
				{ id: "a", title: "A", dependsOn: ["b"] },
				{ id: "b", title: "B", dependsOn: ["a"] },
			]),
			/dependency cycle/,
		);
	});
});
