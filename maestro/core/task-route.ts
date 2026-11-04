import {
	TASK_CATEGORIES,
	type TaskCategory,
	type TaskPreferences,
} from "./config/task-model-types.ts";
import {
	type ModelRegistryAdapter,
	type ParentRuntime,
	type ResolvedRuntimePlan,
	modelScopeOf,
	parseExactModelRef,
	resolveRuntimePlan,
	type ThinkingLevel,
} from "./routing.ts";

const CATEGORY_LIST = TASK_CATEGORIES.join(", ");

/** A rejected `subagent` model selector. Every message names the accepted format. */
export class TaskRouteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskRouteError";
	}
}

/**
 * The only admitted model selector shape: `task:<category>` as the entire
 * value. Direct provider/model IDs, fallback lists, and empty values are
 * refused here, before any pane, worktree, or child process exists.
 */
export function parseTaskModelSelector(raw: string | undefined): TaskCategory {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) {
		throw new TaskRouteError(
			`model is required and must be task:<category>; accepted categories: ${CATEGORY_LIST}`,
		);
	}
	if (trimmed.includes(",")) {
		throw new TaskRouteError(
			"model fallbacks are not accepted; fallbacks belong to models.tasks",
		);
	}
	if (!trimmed.toLowerCase().startsWith("task:")) {
		throw new TaskRouteError(
			`direct provider/model-id is not accepted; pass task:<category> with one of: ${CATEGORY_LIST}`,
		);
	}
	const requested = trimmed.slice("task:".length).trim().toLowerCase();
	const category = TASK_CATEGORIES.find((candidate) => candidate === requested);
	if (!category) {
		throw new TaskRouteError(
			`unknown task category ${JSON.stringify(requested)}; use task:<category> where category is one of: ${CATEGORY_LIST}`,
		);
	}
	return category;
}

/**
 * Concrete models for one category, in configured order, and only those the
 * registry can actually launch. A worktree keeps the first candidate only.
 */
export function expandTaskRoute(
	category: TaskCategory,
	registry: ModelRegistryAdapter,
	taskPreferences: TaskPreferences | undefined,
	worktree: boolean,
): string[] {
	if (!taskPreferences || !Object.hasOwn(taskPreferences, category)) {
		const configured = Object.keys(taskPreferences ?? {});
		throw new TaskRouteError(
			`task category ${JSON.stringify(category)} is not configured; configured categories: ${configured.join(", ") || "(none)"}`,
		);
	}
	const candidates = taskPreferences[category] ?? [];
	const authenticated = candidates.filter((candidate) => {
		const parsed = parseExactModelRef(candidate);
		const model = parsed && registry.find(parsed.provider, parsed.modelId);
		return !!model && registry.hasConfiguredAuth(model);
	});
	if (authenticated.length === 0) {
		const alternatives = registry
			.available()
			.filter((model) => registry.hasConfiguredAuth(model))
			.map((model) => `${model.provider}/${model.id}`);
		throw new TaskRouteError(
			`task category ${JSON.stringify(category)} has no authenticated candidates; authenticated alternatives: ${alternatives.join(", ") || "(none)"}`,
		);
	}
	if (worktree) {
		const [first] = authenticated;
		if (!first) {
			throw new TaskRouteError(
				`task category ${JSON.stringify(category)} has no authenticated candidates`,
			);
		}
		return [first];
	}
	return authenticated;
}

/**
 * Launch admission: reject an inadmissible selector first, then resolve the
 * category's authenticated candidates. Role model defaults are never
 * consulted; the parent model is used only as the last resort described below.
 * `requestedModel` keeps the caller's exact raw string so the outcome ledger
 * can derive the category from it.
 */
export function resolveTaskRoutedPlans(
	args: { model?: string | undefined; thinking?: ThinkingLevel },
	roleThinking: ThinkingLevel | undefined,
	parent: ParentRuntime,
	registry: ModelRegistryAdapter,
	taskPreferences: TaskPreferences | undefined,
	worktree: boolean,
	inheritParentFallback = false,
): ResolvedRuntimePlan[] {
	const category = parseTaskModelSelector(args.model);
	const references = expandTaskRoute(
		category,
		registry,
		taskPreferences,
		worktree,
	);
	const plans = references.map((reference) => {
		const plan = resolveRuntimePlan(
			{ model: reference, thinking: args.thinking },
			{ thinking: roleThinking },
			parent,
			registry,
		);
		return { ...plan, requestedModel: args.model };
	});
	if (inheritParentFallback) {
		// The configured candidates are a priority list, not a guarantee: a
		// provider can be configured yet still fail to launch. Ordinary launches
		// therefore end with the parent runtime (which is authenticated by
		// definition, since it is running) instead of failing outright.
		// Mirror resolveRuntimePlan's inheritance rule here, so an out-of-scope
		// parent is simply not offered instead of failing the whole launch.
		const scope = modelScopeOf(registry);
		const parentRef = `${parent.provider}/${parent.modelId}`;
		const inherited =
			scope && !scope.includes(parentRef)
				? undefined
				: resolveRuntimePlan({}, {}, parent, registry);
		if (inherited && !plans.some((plan) => plan.model === inherited.model)) {
			plans.push({ ...inherited, requestedModel: args.model });
		}
	}
	return plans;
}
