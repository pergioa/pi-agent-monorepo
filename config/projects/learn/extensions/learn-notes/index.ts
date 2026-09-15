/**
 * learn-notes — turn a Learn session into a linked Obsidian notebook.
 *
 * `/learn-notes start <learning prompt>` starts a normal agent turn. The agent
 * derives the notebook title and goal, records the concept plan after probing,
 * and explicitly opens each concept as teaching reaches it. The extension owns
 * paths and files; the model never supplies an arbitrary filesystem path.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { normalizeObsidianMath } from "../md-log.ts";
import {
	LEARN_NOTES_STATE_ENTRY,
	LEARN_NOTES_VERSION,
	addManualConcept,
	appendGeneratedBlock,
	closeConcept,
	createPendingNotebook,
	currentOutputFile,
	findConcept,
	finishNotebook,
	initializeNotebook,
	openConcept,
	setNotebookPlan,
	updateHub,
	type LearnNotebookState,
	type PersistedLearnNotesState,
	type PlannedConcept,
} from "./core.ts";

const QA_TOOLS = new Set(["quiz", "ask_user_question"]);

const LearnNotesParams = Type.Object({
	action: Type.Union([
		Type.Literal("initialize"),
		Type.Literal("set_plan"),
		Type.Literal("open_concept"),
		Type.Literal("complete_concept"),
		Type.Literal("finish"),
	]),
	title: Type.Optional(Type.String({ description: "Concise notebook or concept title, as required by the action" })),
	goal: Type.Optional(Type.String({ description: "The refined learning goal for initialize or set_plan" })),
	conceptId: Type.Optional(Type.String({ description: "Stable concept id from set_plan" })),
	concepts: Type.Optional(Type.Array(Type.Object({
		id: Type.String({ description: "Short stable kebab-case concept id" }),
		title: Type.String({ description: "Readable standalone concept title" }),
		dependsOn: Type.Optional(Type.Array(Type.String({ description: "Concept ids this concept depends on" }))),
	}))),
});

function callout(type: string, title: string, bodyLines: string[]): string {
	const lines = [`> [!${type}] ${title}`];
	for (const line of normalizeObsidianMath(bodyLines.join("\n")).split("\n")) {
		lines.push(line.length === 0 ? ">" : `> ${line}`);
	}
	return lines.join("\n");
}

function userBlock(text: string): string {
	return `> [!quote] YOU\n\n${normalizeObsidianMath(text)}`;
}

function assistantBlock(text: string): string {
	return `> [!abstract] PI\n\n${normalizeObsidianMath(text)}`;
}

function stripSkillBlocks(text: string): string {
	return text.replace(
		/<skill\b([^>]*)>[\s\S]*?<\/skill>/g,
		(_match, attrs: string) => {
			const name = /name="([^"]+)"/.exec(attrs)?.[1];
			return `> [!note] SKILL loaded: ${name ?? "(unknown)"}`;
		},
	);
}

function questionCallout(
	label: string,
	question: string,
	context: string | undefined,
	options: Array<{ label: string }>,
): string {
	const body = question.split("\n");
	if (context) body.push("", ...context.split("\n"));
	if (options.length > 0) body.push("", ...options.map((option, index) => `${index + 1}. ${option.label}`));
	return callout("question", label, body);
}

function quizAnswerCallout(details: any): string {
	if (details?.status === "cancelled") return callout("warning", "Quiz — cancelled", ["(user skipped)"]);
	if (details?.status === "unavailable") return callout("warning", "Quiz — unavailable", [details?.message || ""]);
	const dontKnow = details?.dontKnow === true;
	const correct = details?.correct === true;
	const type = dontKnow ? "question" : correct ? "success" : "failure";
	const title = dontKnow ? "Quiz — I don't know" : correct ? "Quiz — correct ✓" : "Quiz — incorrect ✗";
	const body: string[] = [];
	if (dontKnow) {
		body.push("Your answer: I don't know");
	} else {
		const answers: any[] = details?.answers || [];
		body.push(`Your answer: ${answers.map((answer) => `${answer.index}. ${answer.label}`).join(", ") || "(none)"}`);
	}
	body.push(`Correct answer: ${(details?.correctIndices || []).join(", ")}`);
	if (details?.note) body.push("", `Note: ${String(details.note)}`);
	if (details?.explanation) body.push("", ...String(details.explanation).split("\n"));
	return callout(type, title, body);
}

function askAnswerCallout(details: any): string {
	if (details?.status === "cancelled") return callout("warning", "Question — cancelled", ["(user skipped)"]);
	if (details?.status === "unavailable") return callout("warning", "Question — unavailable", [details?.message || ""]);
	const answers: any[] = details?.answers || [];
	const body = answers.map((answer) => {
		if (answer.type === "other") return `Other: ${answer.label}`;
		if (answer.type === "text") return answer.label;
		return `${answer.index}. ${answer.label}`;
	});
	return callout("example", "Answer", body.length > 0 ? body : ["(no answer)"]);
}

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

export default function learnNotes(pi: ExtensionAPI) {
	let state: LearnNotebookState | null = null;
	let writeLock: Promise<void> = Promise.resolve();
	const qaTargets = new Map<string, string>();
	const loggedQuizQuestions = new Set<string>();

	function withWriteLock<T>(operation: () => T | Promise<T>): Promise<T> {
		const previous = writeLock;
		let release!: () => void;
		writeLock = new Promise<void>((resolve) => { release = resolve; });
		return previous.then(operation).finally(release);
	}

	function persistState(): void {
		pi.appendEntry<PersistedLearnNotesState>(LEARN_NOTES_STATE_ENTRY, { state });
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!state) {
			ctx.ui.setStatus("learn-notes", undefined);
			return;
		}
		const theme = ctx.ui.theme;
		if (state.stage === "pending") {
			ctx.ui.setStatus("learn-notes", theme.fg("accent", "🗂 ") + theme.fg("dim", "preparing notebook"));
			return;
		}
		const current = state.concepts.find((concept) => concept.id === state?.activeConceptId);
		const label = current ? `${state.title} › ${current.title}` : state.title || "Learn notes";
		ctx.ui.setStatus("learn-notes", theme.fg("accent", "🗂 ") + theme.fg("dim", label));
	}

	function restoreState(ctx: ExtensionContext): void {
		state = null;
		qaTargets.clear();
		loggedQuizQuestions.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== LEARN_NOTES_STATE_ENTRY) continue;
			const saved = entry.data as PersistedLearnNotesState | undefined;
			if (saved && "state" in saved) state = saved.state;
		}
		if (state?.version !== LEARN_NOTES_VERSION) state = null;
		if (state?.hubFile) {
			try { updateHub(state); } catch { /* The vault may be temporarily unavailable. */ }
		}
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreState(ctx));

	pi.on("before_agent_start", async (event) => {
		if (!state) return;
		const notebookInstruction = state.stage === "pending"
			? [
				"A structured Learn notebook has just been requested for the user's learning prompt.",
				"Before emitting lesson prose or asking a probe question, call learn_notes with action=initialize.",
				"Derive a concise 2–8 word topic title and a provisional learning goal from the prompt.",
				"After initialization, conduct the normal Learn probe; do not invent concept files yet.",
			].join(" ")
			: [
				`A structured Learn notebook is active: ${state.title}.`,
				"During probing and planning, leave the hub active.",
				"When the dependency plan is ready, call learn_notes action=set_plan with reusable concept-level nodes; this registers notes but does not create them.",
				"After the user approves the plan, call open_concept before teaching each new concept, and complete_concept only once that concept has landed.",
				"Examples, corrections, and quizzes stay in their concept. Do not make a note per turn or per quiz.",
				"Call finish when the learning notebook is complete.",
			].join(" ");
		return { systemPrompt: `${event.systemPrompt}\n\n<learn-notes>\n${notebookInstruction}\n</learn-notes>` };
	});

	pi.registerTool({
		name: "learn_notes",
		label: "Learn Notes",
		description:
			"Manage the active structured Obsidian notebook created by /learn-notes start. Initialize it from the learning prompt, register the concept dependency plan after probing, explicitly open a concept before teaching it, complete concepts after they land, and finish the notebook at the end. This tool owns safe paths and creates concept notes lazily.",
		promptSnippet: "When a structured Learn notebook is active, use learn_notes to initialize it and route each concept deliberately.",
		promptGuidelines: [
			"Use initialize exactly once, before the first lesson prose or probe question, with a concise derived title and provisional goal.",
			"Use set_plan only after probing has identified the learner's edge and the lesson plan is ready. Include reusable concept-level nodes, not conversational turns or quizzes.",
			"After plan approval, use open_concept before teaching each concept. Files are created lazily by this action.",
			"Keep examples, corrections, learner questions, and quizzes in the concept they concern.",
		],
		parameters: LearnNotesParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				switch (params.action) {
					case "initialize": {
						if (!state) throw new Error("No notebook requested. The user must run /learn-notes start first.");
						if (!params.title || !params.goal) throw new Error("initialize requires title and goal");
						state = initializeNotebook(state, params.title, params.goal);
						persistState();
						updateStatus(ctx);
						return {
							content: [{ type: "text", text: `Notebook initialized: ${state.title}. Keep probing in the hub; do not create concept notes until the plan is ready and approved.` }],
							details: { action: params.action, state },
						};
					}
					case "set_plan": {
						if (!state) throw new Error("No active notebook");
						if (!params.concepts?.length) throw new Error("set_plan requires concepts");
						state = setNotebookPlan(state, params.concepts as PlannedConcept[], params.goal);
						persistState();
						updateStatus(ctx);
						return {
							content: [{ type: "text", text: `Plan registered with ${state.concepts.length} concepts. No concept files were created; wait for plan approval before opening one.` }],
							details: { action: params.action, state },
						};
					}
					case "open_concept": {
						if (!state) throw new Error("No active notebook");
						if (!params.conceptId) throw new Error("open_concept requires conceptId");
						state = openConcept(state, params.conceptId);
						persistState();
						updateStatus(ctx);
						const concept = findConcept(state, params.conceptId)!;
						return {
							content: [{ type: "text", text: `Now routing lesson content to: ${concept.title}` }],
							details: { action: params.action, state },
						};
					}
					case "complete_concept": {
						if (!state) throw new Error("No active notebook");
						state = closeConcept(state, params.conceptId);
						persistState();
						updateStatus(ctx);
						return {
							content: [{ type: "text", text: "Concept completed. The hub is active until another concept is opened." }],
							details: { action: params.action, state },
						};
					}
					case "finish": {
						if (!state) throw new Error("No active notebook");
						state = finishNotebook(state);
						persistState();
						updateStatus(ctx);
						return {
							content: [{ type: "text", text: `Notebook completed: ${state.title}` }],
							details: { action: params.action, state },
						};
					}
				}
			} catch (error) {
				return {
					content: [{ type: "text", text: `Learn notes error: ${(error as Error).message}` }],
					details: { action: params.action, error: (error as Error).message, state },
				};
			}
		},
	});

	pi.on("message_end", async (event, ctx) => {
		const file = currentOutputFile(state);
		if (!file) return;
		const message: any = event.message;
		if (!message || !("role" in message)) return;
		const entryId = ctx.sessionManager.getLeafId() || `${message.role}-${Date.now()}`;

		if (message.role === "user") {
			const text = stripSkillBlocks(messageText(message).trim());
			if (text) await withWriteLock(() => appendGeneratedBlock(file, entryId, userBlock(text)));
			return;
		}
		if (message.role === "assistant") {
			const text = messageText(message).trim();
			if (text) await withWriteLock(() => appendGeneratedBlock(file, entryId, assistantBlock(text)));
		}
	});

	pi.on("tool_call", async (event) => {
		if ((event as any).toolName !== "ask_user_question") return;
		const file = currentOutputFile(state);
		if (!file) return;
		const toolCallId = (event as any).toolCallId as string;
		qaTargets.set(toolCallId, file);
		const input = (event as any).input || {};
		const block = questionCallout(
			"Question",
			input.question || "",
			input.details?.trim() || undefined,
			Array.isArray(input.options) ? input.options : [],
		);
		await withWriteLock(() => appendGeneratedBlock(file, `question-${toolCallId}`, block));
	});

	pi.on("tool_execution_update", async (event) => {
		if ((event as any).toolName !== "quiz") return;
		const toolCallId = (event as any).toolCallId as string;
		if (loggedQuizQuestions.has(toolCallId)) return;
		const options = (event as any).partialResult?.details?.options as Array<{ index: number; label: string }> | undefined;
		if (!options?.length) return;
		const file = currentOutputFile(state);
		if (!file) return;
		loggedQuizQuestions.add(toolCallId);
		qaTargets.set(toolCallId, file);
		const input = (event as any).args || {};
		const block = questionCallout(
			"Quiz",
			input.question || "",
			input.details?.trim() || undefined,
			options.map((option) => ({ label: option.label })),
		);
		await withWriteLock(() => appendGeneratedBlock(file, `question-${toolCallId}`, block));
	});

	pi.on("tool_result", async (event) => {
		const toolName = (event as any).toolName;
		if (!QA_TOOLS.has(toolName)) return;
		const toolCallId = (event as any).toolCallId as string;
		const file = qaTargets.get(toolCallId) || currentOutputFile(state);
		if (!file) return;
		const block = toolName === "quiz"
			? quizAnswerCallout((event as any).details)
			: askAnswerCallout((event as any).details);
		await withWriteLock(() => appendGeneratedBlock(file, `answer-${toolCallId}`, block));
		qaTargets.delete(toolCallId);
	});

	pi.registerCommand("learn-notes", {
		description: "Structured Obsidian notes: start, status, list, new, use, close, stop",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const firstSpace = trimmed.indexOf(" ");
			const command = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
			const remainder = trimOuterQuotes(firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1));

			try {
				switch (command || "status") {
					case "start": {
						if (!ctx.isIdle()) {
							ctx.ui.notify("Wait for the agent to finish before starting a notebook.", "warning");
							return;
						}
						if (state) {
							ctx.ui.notify("A Learn notebook is already active. Run /learn-notes stop first.", "warning");
							return;
						}
						const previousPrompt = remainder || lastUserPrompt(ctx);
						if (!previousPrompt) {
							ctx.ui.notify("Usage: /learn-notes start <what you want to learn>", "warning");
							return;
						}
						state = createPendingNotebook(ctx.cwd, previousPrompt, ctx.sessionManager.getSessionId());
						persistState();
						updateStatus(ctx);
						ctx.ui.notify("Structured notebook requested; Pi will derive its title and plan.", "success");
						pi.sendUserMessage(remainder || "Create the structured Learn notebook for my preceding learning request, then continue the lesson using it.");
						return;
					}
					case "status": {
						if (!state) {
							ctx.ui.notify("No structured Learn notebook is active.", "info");
							return;
						}
						const current = state.concepts.find((concept) => concept.id === state?.activeConceptId);
						const location = state.rootDirectory ? `\n${state.rootDirectory}` : "";
						ctx.ui.notify(`${state.title || "Preparing notebook"} — ${state.stage}${current ? ` — ${current.title}` : ""}${location}`, "info");
						return;
					}
					case "list": {
						if (!state?.title) throw new Error("No initialized notebook");
						const lines = state.concepts.length > 0
							? state.concepts.map((concept) => `${concept.id === state?.activeConceptId ? "→" : " "} [${concept.status}] ${concept.id}: ${concept.title}`)
							: ["No concepts planned yet."];
						ctx.ui.notify(lines.join("\n"), "info");
						return;
					}
					case "new": {
						if (!state) throw new Error("No active notebook");
						if (!remainder) throw new Error("Usage: /learn-notes new <concept title>");
						state = addManualConcept(state, remainder);
						persistState();
						updateStatus(ctx);
						ctx.ui.notify(`Created and opened: ${remainder}`, "success");
						return;
					}
					case "use": {
						if (!state) throw new Error("No active notebook");
						if (!remainder) throw new Error("Usage: /learn-notes use <concept id or title>");
						state = openConcept(state, remainder);
						persistState();
						updateStatus(ctx);
						ctx.ui.notify(`Now writing to: ${findConcept(state, remainder)?.title}`, "success");
						return;
					}
					case "close": {
						if (!state) throw new Error("No active notebook");
						state = closeConcept(state, remainder || undefined);
						persistState();
						updateStatus(ctx);
						ctx.ui.notify("Concept completed; writing returned to the hub.", "success");
						return;
					}
					case "stop": {
						if (!state) {
							ctx.ui.notify("No structured Learn notebook is active.", "info");
							return;
						}
						const title = state.title || "Learn notebook";
						state = null;
						persistState();
						updateStatus(ctx);
						ctx.ui.notify(`Stopped structured logging: ${title}. Files were kept.`, "info");
						return;
					}
					default:
						ctx.ui.notify("Usage: /learn-notes start <prompt> | status | list | new <title> | use <id> | close [id] | stop", "warning");
				}
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
			}
		},
	});
}
