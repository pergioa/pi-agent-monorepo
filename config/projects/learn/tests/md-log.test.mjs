import assert from "node:assert/strict";
import test from "node:test";

import { normalizeObsidianMath } from "../extensions/md-log.ts";

test("converts Pi inline and display math delimiters for Obsidian", () => {
	const input = String.raw`To prove \(P(n)\) for every \(n\ge n_0\):

\[
1+2+\cdots+k=\frac{k(k+1)}2.
\]`;
	const expected = String.raw`To prove $P(n)$ for every $n\ge n_0$:

$$
1+2+\cdots+k=\frac{k(k+1)}2.
$$`;

	assert.equal(normalizeObsidianMath(input), expected);
});

test("preserves existing dollar math and escaped literal delimiters", () => {
	const input = String.raw`Keep $x$ and $$y$$, plus \\(literal\\).`;
	assert.equal(normalizeObsidianMath(input), input);
});

test("removes redundant dollar delimiters nested inside Pi delimiters", () => {
	const input = String.raw`Assume \($P(k)$\), then \[$$P(k+1)$$\].`;
	const expected = String.raw`Assume $P(k)$, then $$P(k+1)$$.`;
	assert.equal(normalizeObsidianMath(input), expected);
});

test("does not change delimiters inside inline code", () => {
	const input = "Render \\(x\\), but keep `\\(example\\)` and ``\\[sample\\]``.";
	const expected = "Render $x$, but keep `\\(example\\)` and ``\\[sample\\]``.";
	assert.equal(normalizeObsidianMath(input), expected);
});

test("does not change delimiters inside backtick or tilde code fences", () => {
	const input = [
		"Before \\(x\\).",
		"",
		"```text",
		"\\(code\\)",
		"```",
		"",
		"~~~text",
		"\\[also code\\]",
		"~~~~",
		"",
		"After \\[y\\].",
	].join("\n");
	const expected = [
		"Before $x$.",
		"",
		"```text",
		"\\(code\\)",
		"```",
		"",
		"~~~text",
		"\\[also code\\]",
		"~~~~",
		"",
		"After $$y$$.",
	].join("\n");

	assert.equal(normalizeObsidianMath(input), expected);
});
