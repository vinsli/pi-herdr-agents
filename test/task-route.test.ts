import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	expandTaskRoute,
	parseTaskModelSelector,
	resolveTaskRoutedPlans,
	TaskRouteError,
} from "../maestro/core/task-route.ts";
import { wrapPiModelRegistry } from "../maestro/adapters/pi/model-registry.ts";
import type { ParentRuntime, RoutingModel } from "../maestro/core/routing.ts";
import type { TaskPreferences } from "../maestro/core/config/task-model-types.ts";

const parent: ParentRuntime = {
	provider: "fake",
	modelId: "parent",
	thinking: "medium",
};

function model(
	provider: string,
	id: string,
	overrides: Partial<RoutingModel> = {},
): RoutingModel {
	return {
		provider,
		id,
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 16_000,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	};
}

function registry(entries: RoutingModel[] = [model("fake", "parent")]) {
	const byRef = new Map(
		entries.map((entry) => [`${entry.provider}/${entry.id}`, entry]),
	);
	return wrapPiModelRegistry({
		find(provider: string, modelId: string) {
			return byRef.get(`${provider}/${modelId}`);
		},
		getAvailable() {
			return entries;
		},
		getAll() {
			return entries;
		},
		hasConfiguredAuth(candidate: { provider: string; id: string }) {
			return (
				byRef.has(`${candidate.provider}/${candidate.id}`) &&
				candidate.id !== "unauthed"
			);
		},
	});
}

describe("parseTaskModelSelector", () => {
	it("accepts all six categories, case- and whitespace-insensitively", () => {
		for (const category of [
			"coding",
			"review",
			"recon",
			"qa",
			"architecture",
			"docs",
		]) {
			assert.equal(parseTaskModelSelector(` task:${category} `), category);
			assert.equal(
				parseTaskModelSelector(`task:${category.toUpperCase()}`),
				category,
			);
		}
	});

	it("rejects omitted, empty, direct, fallback, and malformed selectors", () => {
		for (const raw of [
			undefined,
			"",
			"   ",
			"codely/codely-basic",
			"fast",
			"a/x,b/y",
			"task:",
			"task:coding, a/x",
			"a/x, task:coding",
			"task:coding/review",
		]) {
			assert.throws(
				() => parseTaskModelSelector(raw),
				TaskRouteError,
				String(raw),
			);
		}
	});

	it("rejects unknown categories and names the accepted format plus all six categories", () => {
		assert.throws(
			() => parseTaskModelSelector("task:unknown"),
			/task:<category>.*coding, review, recon, qa, architecture, docs/s,
		);
	});

	it("rejects an exact authenticated model ID with an actionable error", () => {
		assert.throws(
			() => parseTaskModelSelector("codely/codely-basic"),
			/direct provider\/model-id is not accepted.*task:<category>/,
		);
	});
});

describe("expandTaskRoute", () => {
	it("expands only authenticated candidates, in configured order, and keeps the first for worktrees", () => {
		const entries = [
			model("fake", "parent"),
			model("other", "worker"),
			model("other", "backup"),
			model("other", "unauthed"),
		];
		const tasks: TaskPreferences = {
			coding: ["other/worker", "other/unauthed", "other/backup"],
		};
		assert.deepEqual(
			expandTaskRoute("coding", registry(entries), tasks, false),
			["other/worker", "other/backup"],
		);
		assert.deepEqual(
			expandTaskRoute("coding", registry(entries), tasks, true),
			["other/worker"],
		);
	});

	it("ignores malformed candidate entries instead of launching them", () => {
		const tasks: TaskPreferences = { qa: ["not-a-ref", "other/worker"] };
		assert.deepEqual(
			expandTaskRoute("qa", registry([model("other", "worker")]), tasks, false),
			["other/worker"],
		);
	});
});

describe("resolveTaskRoutedPlans", () => {
	it("rejects an empty or unauthenticated category instead of inheriting the parent", () => {
		assert.throws(
			() =>
				resolveTaskRoutedPlans(
					{ model: "task:coding" },
					undefined,
					parent,
					registry([model("fake", "parent"), model("other", "unauthed")]),
					{ coding: ["other/unauthed"] },
					false,
				),
			/task category "coding" has no authenticated candidates/,
		);
		assert.throws(
			() =>
				resolveTaskRoutedPlans(
					{ model: "task:docs" },
					undefined,
					parent,
					registry(),
					{},
					false,
				),
			/task category "docs" is not configured/,
		);
	});

	it("resolves plans that keep the raw selector as provenance", () => {
		const plans = resolveTaskRoutedPlans(
			{ model: " task:ReCon ", thinking: "medium" },
			undefined,
			parent,
			registry([model("fake", "parent"), model("other", "worker")]),
			{ recon: ["other/worker"] },
			false,
		);
		assert.equal(plans.length, 1);
		assert.equal(plans[0]?.model, "other/worker");
		assert.equal(plans[0]?.requestedModel, " task:ReCon ");
		assert.equal(plans[0]?.modelSource, "request");
		assert.equal(plans[0]?.thinking, "medium");
	});

	it("keeps configure order across every category candidate", () => {
		const plans = resolveTaskRoutedPlans(
			{ model: "task:coding" },
			undefined,
			parent,
			registry([
				model("fake", "parent"),
				model("other", "worker"),
				model("other", "backup"),
			]),
			{ coding: ["other/worker", "other/backup"] },
			false,
		);
		assert.deepEqual(
			plans.map((plan) => plan.model),
			["other/worker", "other/backup"],
		);
	});

	it("never consults role or parent model defaults", () => {
		assert.throws(
			() =>
				resolveTaskRoutedPlans(
					{},
					"high",
					parent,
					registry(),
					{ coding: ["fake/parent"] },
					false,
				),
			/model is required/,
		);
	});

	it("rejects a direct ID before expanding any category", () => {
		assert.throws(
			() =>
				resolveTaskRoutedPlans(
					{ model: "fake/parent" },
					undefined,
					parent,
					registry(),
					{ coding: ["fake/parent"] },
					false,
				),
			/direct provider\/model-id is not accepted/,
		);
	});
});
