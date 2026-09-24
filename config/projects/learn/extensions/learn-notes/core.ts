import * as fs from "node:fs";
import * as path from "node:path";

export const LEARN_NOTES_STATE_ENTRY = "learn-notes-state";
export const LEARN_NOTES_VERSION = 1;

const INDEX_START = "<!-- learn-notes:index:start -->";
const INDEX_END = "<!-- learn-notes:index:end -->";
const META_START = "<!-- learn-notes:meta:start -->";
const META_END = "<!-- learn-notes:meta:end -->";

export type NotebookStage = "pending" | "active" | "complete";
export type ConceptStatus = "planned" | "learning" | "complete";

export interface PlannedConcept {
	id: string;
	title: string;
	dependsOn?: string[];
}

export interface NotebookConcept {
	id: string;
	title: string;
	file: string;
	dependsOn: string[];
	status: ConceptStatus;
}

export interface LearnNotebookState {
	version: 1;
	stage: NotebookStage;
	sessionId: string;
	createdAt: string;
	updatedAt: string;
	baseDirectory: string;
	sourcePrompt: string;
	title?: string;
	goal?: string;
	rootDirectory?: string;
	hubFile?: string;
	activeConceptId?: string;
	concepts: NotebookConcept[];
}

export interface PersistedLearnNotesState {
	state: LearnNotebookState | null;
}

export function safePathSegment(value: string, fallback = "Untitled"): string {
	const cleaned = value
		.normalize("NFKC")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/[\\/:*?"<>|#[\]^]/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^\.+|\.+$/g, "")
		.trim()
		.slice(0, 80)
		.trim();
	return cleaned || fallback;
}

export function safeConceptId(value: string, fallback = "concept"): string {
	const cleaned = value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64)
		.replace(/-+$/g, "");
	return cleaned || fallback;
}

function nowIso(): string {
	return new Date().toISOString();
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function uniqueDirectory(parent: string, desiredName: string): string {
	const first = path.join(parent, desiredName);
	if (!fs.existsSync(first)) return first;

	const date = new Date().toISOString().slice(0, 10);
	const dated = path.join(parent, `${desiredName} (${date})`);
	if (!fs.existsSync(dated)) return dated;

	for (let counter = 2; ; counter++) {
		const candidate = path.join(parent, `${desiredName} (${date}) ${counter}`);
		if (!fs.existsSync(candidate)) return candidate;
	}
}

function atomicWrite(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
	try {
		fs.writeFileSync(temp, content, "utf-8");
		fs.renameSync(temp, file);
	} finally {
		if (fs.existsSync(temp)) fs.unlinkSync(temp);
	}
}

function replaceManagedRegion(content: string, start: string, end: string, body: string): string {
	const region = `${start}\n${body.trim()}\n${end}`;
	const startIndex = content.indexOf(start);
	const endIndex = content.indexOf(end);
	if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
		return `${content.trimEnd()}\n\n${region}\n`;
	}
	return `${content.slice(0, startIndex)}${region}${content.slice(endIndex + end.length)}`;
}

function obsidianLink(file: string, title: string, rootDirectory: string): string {
	const relative = path.relative(rootDirectory, file).replace(/\\/g, "/").replace(/\.md$/i, "");
	return `[[${relative}|${title}]]`;
}

function vaultDirectory(state: LearnNotebookState): string {
	return path.dirname(state.baseDirectory);
}

function mermaidLabel(title: string): string {
	return title.replace(/["\[\]\n\r]/g, " ").replace(/\s+/g, " ").trim();
}

export function renderNotebookIndex(state: LearnNotebookState): string {
	if (!state.title || !state.goal || !state.rootDirectory) {
		throw new Error("Notebook has not been initialized");
	}

	const lines: string[] = [
		"## Learning goal",
		"",
		state.goal,
		"",
		"## Original request",
		"",
		"> [!quote] Learning prompt",
	];
	for (const line of state.sourcePrompt.split("\n")) lines.push(line ? `> ${line}` : ">");

	lines.push("", "## Dependency map", "");
	if (state.concepts.length === 0) {
		lines.push("_The concept map will be added after probing and plan approval._");
	} else {
		lines.push("```mermaid", "graph TD");
		state.concepts.forEach((concept, index) => {
			lines.push(`  N${index}[\"${mermaidLabel(concept.title)}\"]`);
		});
		const indices = new Map(state.concepts.map((concept, index) => [concept.id, index]));
		for (const [index, concept] of state.concepts.entries()) {
			for (const dependency of concept.dependsOn) {
				const dependencyIndex = indices.get(dependency);
				if (dependencyIndex !== undefined) lines.push(`  N${dependencyIndex} --> N${index}`);
			}
		}
		lines.push("```");
	}

	lines.push("", "## Concept notes", "");
	if (state.concepts.length === 0) {
		lines.push("_No concept notes have been planned yet._");
	} else {
		for (const concept of state.concepts) {
			const marker = concept.status === "complete" ? "x" : concept.status === "learning" ? ">" : " ";
			const link = obsidianLink(concept.file, concept.title, vaultDirectory(state));
			const dependencies = concept.dependsOn
				.map((id) => state.concepts.find((candidate) => candidate.id === id))
				.filter((candidate): candidate is NotebookConcept => Boolean(candidate))
				.map((candidate) => obsidianLink(candidate.file, candidate.title, vaultDirectory(state)));
			const dependencyText = dependencies.length > 0 ? ` — depends on ${dependencies.join(", ")}` : "";
			lines.push(`- [${marker}] ${link}${dependencyText}`);
		}
	}

	lines.push("", "## Notebook status", "", `- Status: ${state.stage}`, `- Updated: ${state.updatedAt}`);
	if (state.activeConceptId) {
		const current = state.concepts.find((concept) => concept.id === state.activeConceptId);
		if (current) lines.push(`- Current concept: ${obsidianLink(current.file, current.title, vaultDirectory(state))}`);
	}
	return lines.join("\n");
}

export function updateHub(state: LearnNotebookState): void {
	if (!state.hubFile || !state.title) return;
	const existing = fs.existsSync(state.hubFile)
		? fs.readFileSync(state.hubFile, "utf-8")
		: `---\ntype: learn-topic\ntitle: ${yamlString(state.title)}\npi_session: ${yamlString(state.sessionId)}\ncreated: ${yamlString(state.createdAt)}\n---\n\n# ${state.title}\n\n${INDEX_START}\n${INDEX_END}\n\n## Learning session\n`;
	atomicWrite(state.hubFile, replaceManagedRegion(existing, INDEX_START, INDEX_END, renderNotebookIndex(state)));
}

function conceptMetadata(state: LearnNotebookState, concept: NotebookConcept): string {
	if (!state.rootDirectory) throw new Error("Notebook has not been initialized");
	const dependencies = concept.dependsOn
		.map((id) => state.concepts.find((candidate) => candidate.id === id))
		.filter((candidate): candidate is NotebookConcept => Boolean(candidate));
	const lines = [
		`- Status: ${concept.status}`,
		`- Topic: ${obsidianLink(state.hubFile || "", state.title || "Topic", vaultDirectory(state))}`,
	];
	if (dependencies.length > 0) {
		lines.push(`- Depends on: ${dependencies.map((item) => obsidianLink(item.file, item.title, vaultDirectory(state))).join(", ")}`);
	}
	return lines.join("\n");
}

export function updateConceptMetadata(state: LearnNotebookState, concept: NotebookConcept): void {
	if (!fs.existsSync(concept.file)) return;
	const existing = fs.readFileSync(concept.file, "utf-8");
	atomicWrite(concept.file, replaceManagedRegion(existing, META_START, META_END, conceptMetadata(state, concept)));
}

function createConceptFile(state: LearnNotebookState, concept: NotebookConcept): void {
	if (fs.existsSync(concept.file)) {
		updateConceptMetadata(state, concept);
		return;
	}
	const content = [
		"---",
		"type: learn-concept",
		`title: ${yamlString(concept.title)}`,
		`learn_id: ${yamlString(concept.id)}`,
		`pi_session: ${yamlString(state.sessionId)}`,
		"---",
		"",
		`# ${concept.title}`,
		"",
		META_START,
		conceptMetadata(state, concept),
		META_END,
		"",
		"## Lesson",
		"",
	].join("\n");
	atomicWrite(concept.file, content);
}

export function createPendingNotebook(cwd: string, sourcePrompt: string, sessionId: string): LearnNotebookState {
	const timestamp = nowIso();
	return {
		version: LEARN_NOTES_VERSION,
		stage: "pending",
		sessionId,
		createdAt: timestamp,
		updatedAt: timestamp,
		baseDirectory: path.join(cwd, "Learn"),
		sourcePrompt: sourcePrompt.trim(),
		concepts: [],
	};
}

export function initializeNotebook(
	state: LearnNotebookState,
	titleInput: string,
	goalInput: string,
): LearnNotebookState {
	if (state.stage !== "pending") return state;
	const title = safePathSegment(titleInput, "Learning Topic");
	const goal = goalInput.trim() || state.sourcePrompt;
	fs.mkdirSync(state.baseDirectory, { recursive: true });
	const rootDirectory = uniqueDirectory(state.baseDirectory, title);
	fs.mkdirSync(rootDirectory, { recursive: true });
	const next: LearnNotebookState = {
		...state,
		stage: "active",
		title,
		goal,
		rootDirectory,
		hubFile: path.join(rootDirectory, `${title}.md`),
		updatedAt: nowIso(),
	};
	updateHub(next);
	return next;
}

function uniqueConceptFile(rootDirectory: string, title: string, used: Set<string>): string {
	const base = safePathSegment(title, "Concept");
	let filename = `${base}.md`;
	let counter = 2;
	while (used.has(filename.toLowerCase())) filename = `${base} ${counter++}.md`;
	used.add(filename.toLowerCase());
	return path.join(rootDirectory, "Concepts", filename);
}

export function setNotebookPlan(
	state: LearnNotebookState,
	planned: PlannedConcept[],
	goal?: string,
): LearnNotebookState {
	if (state.stage === "pending" || !state.rootDirectory) throw new Error("Initialize the notebook first");
	if (planned.length === 0) throw new Error("The plan needs at least one concept");

	const usedIds = new Set<string>();
	const usedFiles = new Set<string>();
	const concepts: NotebookConcept[] = planned.map((item, index) => {
		let id = safeConceptId(item.id || item.title, `concept-${index + 1}`);
		if (usedIds.has(id)) throw new Error(`Duplicate concept id: ${id}`);
		usedIds.add(id);
		const previous = state.concepts.find((candidate) => candidate.id === id);
		const file = previous?.file || uniqueConceptFile(state.rootDirectory!, item.title, usedFiles);
		usedFiles.add(path.basename(file).toLowerCase());
		return {
			id,
			title: item.title.trim() || `Concept ${index + 1}`,
			file,
			dependsOn: [...new Set(item.dependsOn || [])].map((dependency) => safeConceptId(dependency)),
			status: previous?.status || "planned",
		};
	});

	for (const concept of concepts) {
		for (const dependency of concept.dependsOn) {
			if (!usedIds.has(dependency)) throw new Error(`${concept.id} depends on unknown concept: ${dependency}`);
			if (dependency === concept.id) throw new Error(`${concept.id} cannot depend on itself`);
		}
	}
	const byId = new Map(concepts.map((concept) => [concept.id, concept]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	function visit(id: string): void {
		if (visiting.has(id)) throw new Error(`Concept plan contains a dependency cycle at: ${id}`);
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependency of byId.get(id)?.dependsOn || []) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	}
	for (const concept of concepts) visit(concept.id);

	const next: LearnNotebookState = {
		...state,
		goal: goal?.trim() || state.goal,
		concepts,
		activeConceptId: concepts.some((concept) => concept.id === state.activeConceptId)
			? state.activeConceptId
			: undefined,
		updatedAt: nowIso(),
	};
	updateHub(next);
	return next;
}

export function addManualConcept(state: LearnNotebookState, titleInput: string): LearnNotebookState {
	if (!state.rootDirectory) throw new Error("Initialize the notebook first");
	const title = titleInput.trim();
	if (!title) throw new Error("Concept title is required");
	const baseId = safeConceptId(title);
	let id = baseId;
	let counter = 2;
	while (state.concepts.some((concept) => concept.id === id)) id = `${baseId}-${counter++}`;
	const usedFiles = new Set(state.concepts.map((concept) => path.basename(concept.file).toLowerCase()));
	const concept: NotebookConcept = {
		id,
		title,
		file: uniqueConceptFile(state.rootDirectory, title, usedFiles),
		dependsOn: [],
		status: "planned",
	};
	return openConcept({ ...state, concepts: [...state.concepts, concept] }, id);
}

export function findConcept(state: LearnNotebookState, idOrTitle: string): NotebookConcept | undefined {
	const needle = idOrTitle.trim().toLowerCase();
	return state.concepts.find(
		(concept) => concept.id.toLowerCase() === needle || concept.title.toLowerCase() === needle,
	);
}

export function openConcept(state: LearnNotebookState, idOrTitle: string): LearnNotebookState {
	const selected = findConcept(state, idOrTitle);
	if (!selected) throw new Error(`Unknown concept: ${idOrTitle}`);
	const concepts = state.concepts.map((concept) =>
		concept.id === selected.id && concept.status === "planned"
			? { ...concept, status: "learning" as const }
			: concept,
	);
	const next = { ...state, concepts, activeConceptId: selected.id, stage: "active" as const, updatedAt: nowIso() };
	const current = concepts.find((concept) => concept.id === selected.id)!;
	createConceptFile(next, current);
	updateHub(next);
	return next;
}

export function closeConcept(state: LearnNotebookState, idOrTitle?: string): LearnNotebookState {
	const selected = idOrTitle ? findConcept(state, idOrTitle) : state.concepts.find((c) => c.id === state.activeConceptId);
	if (!selected) throw new Error("No matching concept is open");
	const concepts = state.concepts.map((concept) =>
		concept.id === selected.id ? { ...concept, status: "complete" as const } : concept,
	);
	const next = {
		...state,
		concepts,
		activeConceptId: state.activeConceptId === selected.id ? undefined : state.activeConceptId,
		updatedAt: nowIso(),
	};
	updateConceptMetadata(next, concepts.find((concept) => concept.id === selected.id)!);
	updateHub(next);
	return next;
}

export function finishNotebook(state: LearnNotebookState): LearnNotebookState {
	const next = { ...state, stage: "complete" as const, activeConceptId: undefined, updatedAt: nowIso() };
	updateHub(next);
	return next;
}

export function currentOutputFile(state: LearnNotebookState | null): string | undefined {
	if (!state || state.stage === "pending") return undefined;
	if (state.activeConceptId) return state.concepts.find((concept) => concept.id === state.activeConceptId)?.file;
	return state.hubFile;
}

export function appendGeneratedBlock(file: string, blockId: string, markdown: string): boolean {
	const safeId = blockId.replace(/[^a-zA-Z0-9_.:-]/g, "-");
	const marker = `<!-- learn-notes:block:${safeId} -->`;
	const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
	if (existing.includes(marker)) return false;
	let separator = "";
	if (existing.length > 0 && !existing.endsWith("\n\n")) {
		separator = existing.endsWith("\n") ? "\n" : "\n\n";
	}
	atomicWrite(file, `${existing}${separator}${marker}\n${markdown.trim()}\n`);
	return true;
}
