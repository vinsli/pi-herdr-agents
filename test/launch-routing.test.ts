import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLaunchPlanner } from "../pi-extension/subagents/launch.ts";
import type { ModelConfig } from "../maestro/core/config/model-config.ts";
import type { RoutingModel } from "../maestro/core/routing.ts";

function model(provider: string, id: string): RoutingModel {
	return {
		provider,
		id,
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 16_000,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	};
}

const entries = [
	model("fake", "parent"),
	model("fake", "worker"),
	model("other", "worker"),
];

function modelRegistry(available = entries) {
	const byRef = new Map(
		available.map((entry) => [`${entry.provider}/${entry.id}`, entry]),
	);
	return {
		find(provider: string, modelId: string) {
			return byRef.get(`${provider}/${modelId}`);
		},
		getAvailable() {
			return available;
		},
		getAll() {
			return available;
		},
		hasConfiguredAuth(candidate: { provider: string; id: string }) {
			return byRef.has(`${candidate.provider}/${candidate.id}`);
		},
	};
}

const ctx = {
	cwd: "/tmp/piha-launch-routing",
	sessionManager: {
		getSessionFile: () => "/tmp/piha-launch-routing/session.jsonl",
		getSessionId: () => "session",
		getSessionDir: () => "/tmp/piha-launch-routing",
	},
	model: { provider: "fake", id: "parent" },
	modelRegistry: modelRegistry(),
};

function plannerWith(modelConfig: ModelConfig) {
	return createLaunchPlanner({
		// Bare agents never consult `runtime.pi`; only named roles load defaults.
		runtime: {} as never,
		modelConfig,
		paneConfig: {} as never,
	});
}

function params(extra: Record<string, unknown> = {}) {
	return { name: "probe", task: "do the thing", ...extra } as never;
}

describe("launch admission", () => {
	it("rejects a direct model ID at the launch boundary", () => {
		const planner = plannerWith({ agents: {} });
		assert.throws(
			() =>
				planner.resolveSubagentRuntimePlans(
					params({ model: "fake/worker" }),
					ctx as never,
					"medium",
				),
			/direct provider\/model-id is not accepted/,
		);
	});

	it("rejects a missing model even when models.default and models.agents are configured", () => {
		const planner = plannerWith({
			agents: { researcher: "fake/worker" },
			default: "fake/worker",
		} as ModelConfig);
		assert.throws(
			() =>
				planner.resolveSubagentRuntimePlans(params(), ctx as never, "medium"),
			/model is required/,
		);
	});

	it("rejects a fallback list", () => {
		const planner = plannerWith({ agents: {} });
		assert.throws(
			() =>
				planner.resolveSubagentRuntimePlans(
					params({ model: "fake/worker,other/worker" }),
					ctx as never,
					"medium",
				),
			/model fallbacks are not accepted/,
		);
	});

	it("resolves a task route and ignores models.agents", () => {
		const planner = plannerWith({
			agents: { researcher: "fake/parent" },
			tasks: { recon: ["other/worker"] },
		} as ModelConfig);
		const plans = planner.resolveSubagentRuntimePlans(
			params({ model: "task:recon" }),
			ctx as never,
			"medium",
		);
		assert.deepEqual(
			plans.map((plan) => plan.model),
			["other/worker"],
		);
		assert.equal(plans[0]?.requestedModel, "task:recon");
	});

	it("rejects a category with no authenticated candidates", () => {
		const planner = plannerWith({
			agents: {},
			tasks: { coding: ["other/missing"] },
		} as ModelConfig);
		assert.throws(
			() =>
				planner.resolveSubagentRuntimePlans(
					params({ model: "task:coding" }),
					ctx as never,
					"medium",
				),
			/task category "coding" has no authenticated candidates/,
		);
	});

	it("keeps only the first candidate for a worktree launch", () => {
		const planner = plannerWith({
			agents: {},
			tasks: { coding: ["fake/worker", "other/worker"] },
		} as ModelConfig);
		const plans = planner.resolveSubagentRuntimePlans(
			params({ model: "task:coding", worktree: { branch: "local/probe" } }),
			ctx as never,
			"medium",
		);
		assert.deepEqual(
			plans.map((plan) => plan.model),
			["fake/worker"],
		);
	});
});
