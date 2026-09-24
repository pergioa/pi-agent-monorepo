import assert from "node:assert/strict";
import test from "node:test";

import {
	completeCoachStep,
	createCoachState,
	finishCoach,
	formatCoachStatus,
	recordCoachVerification,
	requestCoachHint,
	setCoachMode,
	setCoachPlan,
	startCoachStep,
} from "../extensions/assignment-coach/core.ts";

const CREATED_AT = "2026-09-24T10:00:00.000Z";

function plannedState() {
	return setCoachPlan(
		createCoachState("Implement token validation", "/tmp/project", "session-1", "guided", CREATED_AT),
		["Expired tokens are rejected", "Valid tokens are consumed"],
		[
			{ id: "add-checks", title: "Add token checks", why: "Establish the behavior first" },
			{ id: "add-tests", title: "Cover edge cases", why: "Protect the behavior" },
		],
		CREATED_AT,
	);
}

test("creates an inert guided workflow for the current directory", () => {
	const state = createCoachState("  Implement token validation  ", "/tmp/project", "session-1", "guided", CREATED_AT);

	assert.equal(state.task, "Implement token validation");
	assert.equal(state.cwd, "/tmp/project");
	assert.equal(state.mode, "guided");
	assert.equal(state.stage, "intake");
	assert.deepEqual(state.steps, []);
	assert.equal(state.hintLevel, 0);
});

test("requires concrete criteria and stable unique milestone ids", () => {
	const state = createCoachState("Task", "/tmp/project", "session-1", "guided", CREATED_AT);

	assert.throws(() => setCoachPlan(state, [], [{ id: "step-one", title: "Step" }]), /acceptance criterion/);
	assert.throws(() => setCoachPlan(state, ["Works"], []), /implementation step/);
	assert.throws(
		() => setCoachPlan(state, ["Works"], [
			{ id: "same", title: "First" },
			{ id: "same", title: "Second" },
		]),
		/Duplicate step id/,
	);
	assert.throws(
		() => setCoachPlan(state, ["Works"], [{ id: "Not Valid", title: "Step" }]),
		/lowercase kebab-case/,
	);
});

test("tracks one active milestone and resets its hint ladder", () => {
	let state = plannedState();
	state = startCoachStep(state, "add-checks", CREATED_AT);
	for (let index = 0; index < 8; index++) state = requestCoachHint(state, CREATED_AT);

	assert.equal(state.activeStepId, "add-checks");
	assert.equal(state.hintLevel, 5);
	assert.equal(state.steps.find((step) => step.id === "add-checks")?.status, "active");

	state = startCoachStep(state, "add-tests", CREATED_AT);
	assert.equal(state.steps.find((step) => step.id === "add-checks")?.status, "pending");
	assert.equal(state.steps.find((step) => step.id === "add-tests")?.status, "active");
	assert.equal(state.hintLevel, 0);

	state = completeCoachStep(state, undefined, CREATED_AT);
	assert.equal(state.steps.find((step) => step.id === "add-tests")?.status, "complete");
	assert.equal(state.activeStepId, undefined);
});

test("does not finish before all milestones and verification are complete", () => {
	let state = plannedState();
	assert.throws(() => finishCoach(state), /Incomplete coach steps/);

	state = completeCoachStep(state, "add-checks", CREATED_AT);
	state = completeCoachStep(state, "add-tests", CREATED_AT);
	assert.throws(() => finishCoach(state), /verification evidence/);

	state = recordCoachVerification(state, "npm test: 12 tests passed", CREATED_AT);
	state = recordCoachVerification(state, "npm test: 12 tests passed", CREATED_AT);
	state = finishCoach(state, CREATED_AT);

	assert.equal(state.stage, "complete");
	assert.deepEqual(state.verificationEvidence, ["npm test: 12 tests passed"]);
});

test("changes mode explicitly and formats a useful status", () => {
	let state = setCoachMode(plannedState(), "pair", CREATED_AT);
	state = startCoachStep(state, "add-checks", CREATED_AT);
	const status = formatCoachStatus(state);

	assert.match(status, /Mode: pair/);
	assert.match(status, /Stage: implementation/);
	assert.match(status, /\[>\] add-checks: Add token checks/);
	assert.match(status, /\[ \] add-tests: Cover edge cases/);
});
