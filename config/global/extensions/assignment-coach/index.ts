/**
 * Globally available, explicitly activated coding-assignment coach.
 *
 * `/coach start <task>` persists the workflow in the current Pi session. While
 * active, the extension injects the current checkpoint and exposes a small tool
 * for the agent to keep milestones synchronized with the conversation.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	ASSIGNMENT_COACH_STATE_ENTRY,
	ASSIGNMENT_COACH_VERSION,
	completeCoachStep,
	createCoachState,
	finishCoach,
	formatCoachStatus,
	recordCoachVerification,
	requestCoachHint,
	setCoachMode,
	setCoachPlan,
	setCoachStage,
	startCoachStep,
	type AssignmentCoachState,
	type CoachMode,
	type PersistedAssignmentCoachState,
} from "./core.ts";

const CoachParams = Type.Object({
	action: Type.Union([
		Type.Literal("set_stage"),
		Type.Literal("set_plan"),
		Type.Literal("start_step"),
		Type.Literal("complete_step"),
		Type.Literal("record_verification"),
		Type.Literal("finish"),
	]),
	stage: Type.Optional(Type.Union([
		Type.Literal("intake"),
		Type.Literal("probe"),
		Type.Literal("plan"),
		Type.Literal("implementation"),
		Type.Literal("verification"),
	])),
	acceptanceCriteria: Type.Optional(Type.Array(Type.String({ description: "One observable completion criterion" }))),
	steps: Type.Optional(Type.Array(Type.Object({
		id: Type.String({ description: "Stable lowercase kebab-case milestone id" }),
		title: Type.String({ description: "Short implementation milestone" }),
		why: Type.Optional(Type.String({ description: "Why this milestone comes at this point" })),
	}))),
	stepId: Type.Optional(Type.String({ description: "Milestone id from the registered plan" })),
	evidence: Type.Optional(Type.String({ description: "Concrete verification command or observed behavior and its result" })),
});

function messageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((part: any) => part.type === "text")
		.map((part: any) => String(part.text || "").trim())
		.filter(Boolean)
		.join("\n\n");
}

function lastUserPrompt(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry: any = branch[index];
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = messageText(entry.message).replace(/<skill\b[^>]*>[\s\S]*?<\/skill>/g, "").trim();
		if (text) return text;
	}
	return undefined;
}

function trimOuterQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function parseMode(value: string): CoachMode | undefined {
	return value === "guided" || value === "pair" || value === "demo" ? value : undefined;
}

function activeStepLabel(state: AssignmentCoachState): string | undefined {
	return state.steps.find((step) => step.id === state.activeStepId)?.title;
}

function coachPrompt(state: AssignmentCoachState): string {
	const current = activeStepLabel(state);
	const completed = state.steps.filter((step) => step.status === "complete").length;
	const summary = [
		`Task: ${state.task}`,
		`Working directory: ${state.cwd}`,
		`Mode: ${state.mode}`,
		`Stage: ${state.stage}`,
		`Progress: ${completed}/${state.steps.length || 0} planned steps complete`,
		current ? `Active step: ${current}` : "Active step: none",
		`Requested hint level: ${state.hintLevel}`,
	].join("\n");
	return [
		"An assignment-coach workflow is active. Load and follow the implementation-coach skill before responding.",
		"Keep the workflow synchronized with the assignment_coach tool. Inspect before planning, register the plan, and wait for plan approval before starting a step.",
		"In guided mode, do not edit implementation or test files unless the user's latest message explicitly asks you to make that edit. Starting, continuing, checking, explaining, or requesting a hint is not edit permission.",
		"Answer conceptual interruptions in the context of the current task, then return to the saved checkpoint.",
		"Current state:",
		summary,
	].join("\n");
}

export default function assignmentCoach(pi: ExtensionAPI) {
	let state: AssignmentCoachState | null = null;
	let stateLock: Promise<void> = Promise.resolve();

	function withStateLock<T>(operation: () => T | Promise<T>): Promise<T> {
		const previous = stateLock;
		let release!: () => void;
		stateLock = new Promise<void>((resolve) => { release = resolve; });
		return previous.then(operation).finally(release);
	}

	function setCoachToolEnabled(enabled: boolean): void {
		const active = new Set(pi.getActiveTools());
		if (enabled) active.add("assignment_coach");
		else active.delete("assignment_coach");
		pi.setActiveTools(Array.from(active));
	}

	function persistState(): void {
		pi.appendEntry<PersistedAssignmentCoachState>(ASSIGNMENT_COACH_STATE_ENTRY, { state });
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!state) {
			ctx.ui.setStatus("assignment-coach", undefined);
			return;
		}
		const current = activeStepLabel(state);
		const label = `coach ${state.mode}: ${current || state.stage}`;
		ctx.ui.setStatus("assignment-coach", ctx.ui.theme.fg("accent", label));
	}

	function restoreState(ctx: ExtensionContext): void {
		state = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ASSIGNMENT_COACH_STATE_ENTRY) continue;
			const saved = entry.data as PersistedAssignmentCoachState | undefined;
			if (saved && "state" in saved) state = saved.state;
		}
		if (state?.version !== ASSIGNMENT_COACH_VERSION) state = null;
		setCoachToolEnabled(Boolean(state && state.stage !== "complete"));
		updateStatus(ctx);
	}

	function save(next: AssignmentCoachState, ctx: ExtensionContext): AssignmentCoachState {
		state = next;
		persistState();
		setCoachToolEnabled(next.stage !== "complete");
		updateStatus(ctx);
		return next;
	}

	pi.on("session_start", async (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreState(ctx));

	pi.on("before_agent_start", async (event) => {
		if (!state || state.stage === "complete") return;
		return { systemPrompt: `${event.systemPrompt}\n\n<assignment-coach>\n${coachPrompt(state)}\n</assignment-coach>` };
	});

	pi.registerTool({
		name: "assignment_coach",
		label: "Assignment Coach",
		description: "Update the active /coach workflow as it moves through inspection, probing, planning, implementation milestones, verification, and completion.",
		promptSnippet: "When /coach is active, keep its stage, plan, active milestone, and verification evidence synchronized with assignment_coach.",
		promptGuidelines: [
			"Call set_plan after inspecting and probing, before asking the user to approve the implementation plan.",
			"Wait for explicit plan approval before calling start_step.",
			"Call complete_step only after the milestone's behavior has been checked.",
			"Record concrete verification evidence before finish; finish rejects incomplete milestones or missing evidence.",
		],
		parameters: CoachParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return withStateLock(async () => {
				if (!state) throw new Error("No coach workflow is active. Run /coach start <assignment> first.");
				switch (params.action) {
					case "set_stage": {
						if (!params.stage) throw new Error("set_stage requires stage");
						const next = save(setCoachStage(state, params.stage), ctx);
						return { content: [{ type: "text", text: `Coach stage: ${next.stage}` }], details: { action: params.action, state: next } };
					}
					case "set_plan": {
						if (!params.acceptanceCriteria || !params.steps) throw new Error("set_plan requires acceptanceCriteria and steps");
						const next = save(setCoachPlan(state, params.acceptanceCriteria, params.steps), ctx);
						return { content: [{ type: "text", text: `Registered ${next.steps.length} milestones. Present the plan and wait for approval.` }], details: { action: params.action, state: next } };
					}
					case "start_step": {
						if (!params.stepId) throw new Error("start_step requires stepId");
						const next = save(startCoachStep(state, params.stepId), ctx);
						return { content: [{ type: "text", text: `Active milestone: ${activeStepLabel(next)}` }], details: { action: params.action, state: next } };
					}
					case "complete_step": {
						const next = save(completeCoachStep(state, params.stepId), ctx);
						return { content: [{ type: "text", text: "Milestone completed." }], details: { action: params.action, state: next } };
					}
					case "record_verification": {
						if (!params.evidence) throw new Error("record_verification requires evidence");
						const next = save(recordCoachVerification(state, params.evidence), ctx);
						return { content: [{ type: "text", text: "Verification evidence recorded." }], details: { action: params.action, state: next } };
					}
					case "finish": {
						const next = save(finishCoach(state), ctx);
						return { content: [{ type: "text", text: "Assignment coaching workflow completed." }], details: { action: params.action, state: next } };
					}
				}
				throw new Error(`Unknown assignment coach action: ${String(params.action)}`);
			});
		},
	});

	pi.registerCommand("coach", {
		description: "Coding assignment coach: start, mode, status, hint, explain, check, stop",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const firstSpace = trimmed.indexOf(" ");
			const command = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
			const remainder = trimOuterQuotes(firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1));

			try {
				switch (command || "status") {
					case "start": {
						if (!ctx.isIdle()) {
							ctx.ui.notify("Wait for the agent to finish before starting the coach.", "warning");
							return;
						}
						if (state && state.stage !== "complete") {
							ctx.ui.notify("A coach workflow is already active. Run /coach stop first.", "warning");
							return;
						}
						const task = remainder || lastUserPrompt(ctx);
						if (!task) {
							ctx.ui.notify("Usage: /coach start <assignment>", "warning");
							return;
						}
						state = createCoachState(task, ctx.cwd, ctx.sessionManager.getSessionId());
						persistState();
						setCoachToolEnabled(true);
						updateStatus(ctx);
						ctx.ui.notify("Guided assignment coaching started.", "success");
						pi.sendUserMessage(`Coach me through this coding assignment in guided mode. Begin by inspecting the repository without editing implementation or test files.\n\n${task}`);
						return;
					}
					case "mode": {
						if (!state) throw new Error("No active coach workflow");
						const mode = parseMode(remainder.toLowerCase());
						if (!mode) throw new Error("Usage: /coach mode guided|pair|demo");
						save(setCoachMode(state, mode), ctx);
						ctx.ui.notify(`Coach mode: ${mode}`, "success");
						return;
					}
					case "status": {
						if (!state) {
							ctx.ui.notify("No assignment coach is active.", "info");
							return;
						}
						ctx.ui.notify(formatCoachStatus(state), "info");
						return;
					}
					case "hint": {
						if (!state) throw new Error("No active coach workflow");
						const next = save(requestCoachHint(state), ctx);
						pi.sendUserMessage(`Give me hint level ${next.hintLevel} for the current assignment checkpoint. Do not take over the implementation.`);
						return;
					}
					case "explain": {
						if (!state) throw new Error("No active coach workflow");
						if (!remainder) throw new Error("Usage: /coach explain <concept or question>");
						pi.sendUserMessage(`Pause at the current assignment checkpoint and explain this in the context of the codebase: ${remainder}\n\nAfter answering, remind me what the current checkpoint is.`);
						return;
					}
					case "check": {
						if (!state) throw new Error("No active coach workflow");
						pi.sendUserMessage("Inspect my current assignment work and run the narrowest relevant checks. Give coaching feedback without editing implementation or test files unless I explicitly ask.");
						return;
					}
					case "stop": {
						if (!state) {
							ctx.ui.notify("No assignment coach is active.", "info");
							return;
						}
						state = null;
						persistState();
						setCoachToolEnabled(false);
						updateStatus(ctx);
						ctx.ui.notify("Assignment coaching stopped. Session history was kept.", "info");
						return;
					}
					default:
						ctx.ui.notify("Usage: /coach start <assignment> | mode guided|pair|demo | status | hint | explain <topic> | check | stop", "warning");
				}
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
			}
		},
	});
}
