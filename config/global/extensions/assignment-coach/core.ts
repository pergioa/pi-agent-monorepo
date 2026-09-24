export const ASSIGNMENT_COACH_STATE_ENTRY = "assignment-coach-state";
export const ASSIGNMENT_COACH_VERSION = 1;
export const MAX_HINT_LEVEL = 5;

export type CoachMode = "guided" | "pair" | "demo";
export type CoachStage = "intake" | "probe" | "plan" | "implementation" | "verification" | "complete";
export type CoachStepStatus = "pending" | "active" | "complete";

export interface PlannedCoachStep {
	id: string;
	title: string;
	why?: string;
}

export interface CoachStep {
	id: string;
	title: string;
	why: string;
	status: CoachStepStatus;
}

export interface AssignmentCoachState {
	version: 1;
	task: string;
	cwd: string;
	sessionId: string;
	mode: CoachMode;
	stage: CoachStage;
	acceptanceCriteria: string[];
	steps: CoachStep[];
	activeStepId?: string;
	hintLevel: number;
	verificationEvidence: string[];
	createdAt: string;
	updatedAt: string;
}

export interface PersistedAssignmentCoachState {
	state: AssignmentCoachState | null;
}

function timestamp(now?: string): string {
	return now || new Date().toISOString();
}

function required(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} is required`);
	return trimmed;
}

function validateStepId(value: string): string {
	const id = required(value, "Step id");
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
		throw new Error(`Invalid step id: ${id}. Use lowercase kebab-case.`);
	}
	return id;
}

export function createCoachState(
	taskInput: string,
	cwd: string,
	sessionId: string,
	mode: CoachMode = "guided",
	now?: string,
): AssignmentCoachState {
	const createdAt = timestamp(now);
	return {
		version: ASSIGNMENT_COACH_VERSION,
		task: required(taskInput, "Assignment"),
		cwd,
		sessionId,
		mode,
		stage: "intake",
		acceptanceCriteria: [],
		steps: [],
		hintLevel: 0,
		verificationEvidence: [],
		createdAt,
		updatedAt: createdAt,
	};
}

export function setCoachMode(state: AssignmentCoachState, mode: CoachMode, now?: string): AssignmentCoachState {
	return { ...state, mode, updatedAt: timestamp(now) };
}

export function setCoachStage(
	state: AssignmentCoachState,
	stage: Exclude<CoachStage, "complete">,
	now?: string,
): AssignmentCoachState {
	return { ...state, stage, updatedAt: timestamp(now) };
}

export function setCoachPlan(
	state: AssignmentCoachState,
	criteriaInput: string[],
	planned: PlannedCoachStep[],
	now?: string,
): AssignmentCoachState {
	const acceptanceCriteria = criteriaInput.map((item) => item.trim()).filter(Boolean);
	if (acceptanceCriteria.length === 0) throw new Error("The plan needs at least one acceptance criterion");
	if (planned.length === 0) throw new Error("The plan needs at least one implementation step");

	const usedIds = new Set<string>();
	const steps = planned.map((item, index): CoachStep => {
		const id = validateStepId(item.id);
		if (usedIds.has(id)) throw new Error(`Duplicate step id: ${id}`);
		usedIds.add(id);
		const previous = state.steps.find((candidate) => candidate.id === id);
		return {
			id,
			title: required(item.title, `Step ${index + 1} title`),
			why: item.why?.trim() || "",
			status: previous?.status === "complete" ? "complete" : "pending",
		};
	});

	return {
		...state,
		stage: "plan",
		acceptanceCriteria,
		steps,
		activeStepId: undefined,
		hintLevel: 0,
		verificationEvidence: [],
		updatedAt: timestamp(now),
	};
}

export function startCoachStep(state: AssignmentCoachState, stepIdInput: string, now?: string): AssignmentCoachState {
	const stepId = stepIdInput.trim();
	const selected = state.steps.find((step) => step.id === stepId);
	if (!selected) throw new Error(`Unknown coach step: ${stepIdInput}`);
	if (selected.status === "complete") throw new Error(`Coach step is already complete: ${stepId}`);

	const steps = state.steps.map((step): CoachStep => {
		if (step.id === stepId) return { ...step, status: "active" };
		if (step.status === "active") return { ...step, status: "pending" };
		return step;
	});
	return {
		...state,
		stage: "implementation",
		steps,
		activeStepId: stepId,
		hintLevel: 0,
		updatedAt: timestamp(now),
	};
}

export function completeCoachStep(state: AssignmentCoachState, stepIdInput?: string, now?: string): AssignmentCoachState {
	const stepId = (stepIdInput || state.activeStepId || "").trim();
	if (!stepId) throw new Error("No coach step is active");
	if (!state.steps.some((step) => step.id === stepId)) throw new Error(`Unknown coach step: ${stepId}`);

	const steps = state.steps.map((step): CoachStep =>
		step.id === stepId ? { ...step, status: "complete" } : step,
	);
	return {
		...state,
		steps,
		activeStepId: state.activeStepId === stepId ? undefined : state.activeStepId,
		hintLevel: 0,
		updatedAt: timestamp(now),
	};
}

export function requestCoachHint(state: AssignmentCoachState, now?: string): AssignmentCoachState {
	return {
		...state,
		hintLevel: Math.min(MAX_HINT_LEVEL, state.hintLevel + 1),
		updatedAt: timestamp(now),
	};
}

export function recordCoachVerification(
	state: AssignmentCoachState,
	evidenceInput: string,
	now?: string,
): AssignmentCoachState {
	const evidence = required(evidenceInput, "Verification evidence");
	return {
		...state,
		stage: "verification",
		verificationEvidence: state.verificationEvidence.includes(evidence)
			? state.verificationEvidence
			: [...state.verificationEvidence, evidence],
		updatedAt: timestamp(now),
	};
}

export function finishCoach(state: AssignmentCoachState, now?: string): AssignmentCoachState {
	if (state.steps.length === 0) throw new Error("Create an implementation plan before finishing");
	const incomplete = state.steps.filter((step) => step.status !== "complete");
	if (incomplete.length > 0) throw new Error(`Incomplete coach steps: ${incomplete.map((step) => step.id).join(", ")}`);
	if (state.verificationEvidence.length === 0) throw new Error("Record verification evidence before finishing");
	return {
		...state,
		stage: "complete",
		activeStepId: undefined,
		hintLevel: 0,
		updatedAt: timestamp(now),
	};
}

export function formatCoachStatus(state: AssignmentCoachState): string {
	const lines = [
		`Assignment: ${state.task}`,
		`Mode: ${state.mode}`,
		`Stage: ${state.stage}`,
		`Directory: ${state.cwd}`,
	];
	if (state.steps.length > 0) {
		lines.push("Steps:");
		for (const step of state.steps) {
			const marker = step.status === "complete" ? "x" : step.status === "active" ? ">" : " ";
			lines.push(`[${marker}] ${step.id}: ${step.title}`);
		}
	}
	if (state.hintLevel > 0) lines.push(`Hint level: ${state.hintLevel}/${MAX_HINT_LEVEL}`);
	if (state.verificationEvidence.length > 0) lines.push(`Verification records: ${state.verificationEvidence.length}`);
	return lines.join("\n");
}
