import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLaunchPlanner } from "../pi-extension/subagents/launch.ts";
import type { LaunchParams } from "../pi-extension/subagents/catalog.ts";
import type { ModelConfig } from "../maestro/core/config/model-config.ts";
import type { PaneConfig } from "../maestro/core/config/pane-config.ts";
import type { RoutingModel, ThinkingLevel } from "../maestro/core/routing.ts";
import type { SubagentRuntime } from "../pi-extension/subagents/state.ts";

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

const parentContext = {
	cwd: "/tmp/piha-launch-routing",
	sessionManager: {
		getSessionFile: () => "/tmp/piha-launch-routing/session.jsonl",
		getSessionId: () => "session",
		getSessionDir: () => "/tmp/piha-launch-routing",
	},
	model: { provider: "fake", id: "parent" },
	modelRegistry: modelRegistry(),
};

type LaunchContext = Parameters<
	ReturnType<typeof createLaunchPlanner>["resolveSubagentRuntimePlans"]
>[1];

const paneConfig: PaneConfig = {
	mode: "tab",
	direction: "right",
	maxPerTab: 4,
};

/** Only `runtime.pi` is read, and only for named roles, which these probes never use. */
const runtime: SubagentRuntime = { runningSubagents: new Map() };

function plannerWith(modelConfig: ModelConfig) {
	return createLaunchPlanner({ runtime, modelConfig, paneConfig });
}

function resolve(
	modelConfig: ModelConfig,
	params: LaunchParams,
	ctx: LaunchContext = parentContext,
): string[] {
	return plannerWith(modelConfig)
		.resolveSubagentRuntimePlans(params, ctx, "medium" satisfies ThinkingLevel)
		.map((plan) => plan.model);
}

const probe: LaunchParams = { name: "probe", task: "do the thing" };

describe("launch admission", () => {
	it("rejects a direct model ID at the launch boundary", () => {
		assert.throws(
			() => resolve({ agents: {} }, { ...probe, model: "fake/worker" }),
			/direct provider\/model-id is not accepted/,
		);
	});

	it("rejects a missing model even when models.default and models.agents are configured", () => {
		assert.throws(
			() =>
				resolve(
					{ agents: { researcher: "fake/worker" }, default: "fake/worker" },
					probe,
				),
			/model is required/,
		);
	});

	it("rejects a fallback list", () => {
		assert.throws(
			() =>
				resolve(
					{ agents: {} },
					{ ...probe, model: "fake/worker,other/worker" },
				),
			/model fallbacks are not accepted/,
		);
	});

	it("resolves a task route and ignores models.agents", () => {
		assert.deepEqual(
			resolve(
				{
					agents: { researcher: "fake/parent" },
					tasks: { recon: ["other/worker"] },
				},
				{ ...probe, model: "task:recon" },
			),
			["other/worker", "fake/parent"],
			"the shortlist is followed by the parent runtime fallback",
		);
	});

	it("keeps the requested selector as provenance for the outcome ledger", () => {
		const plans = plannerWith({
			agents: {},
			tasks: { recon: ["other/worker"] },
		}).resolveSubagentRuntimePlans(
			{ ...probe, model: "task:recon" },
			parentContext,
			"medium",
		);
		assert.equal(plans[0]?.requestedModel, "task:recon");
		assert.equal(plans[1]?.modelSource, "parent");
	});

	it("rejects a category with no authenticated candidates", () => {
		assert.throws(
			() =>
				resolve(
					{ agents: {}, tasks: { coding: ["other/missing"] } },
					{ ...probe, model: "task:coding" },
				),
			/task category "coding" has no authenticated candidates/,
		);
	});

	it("keeps a persistent specialist on the shortlist without the parent fallback", () => {
		assert.deepEqual(
			resolve(
				{ agents: {}, tasks: { coding: ["other/worker"] } },
				{ ...probe, model: "task:coding", persistent: true },
			),
			["other/worker"],
		);
	});

	it("keeps only the first candidate for a worktree launch", () => {
		assert.deepEqual(
			resolve(
				{ agents: {}, tasks: { coding: ["fake/worker", "other/worker"] } },
				{ ...probe, model: "task:coding", worktree: { branch: "local/probe" } },
			),
			["fake/worker"],
		);
	});
});
