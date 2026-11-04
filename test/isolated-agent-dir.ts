import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import before the extension: configuration is loaded during module evaluation.
const directory = mkdtempSync(join(tmpdir(), "initfix-test-agent-"));
process.env.PI_CODING_AGENT_DIR = directory;

/**
 * Local fork: every launch selects a task category, so the shared model config
 * carries shortlists standing in for the ordered model lists these tests used to
 * pass directly. `recon` is exactly the parent model, so it also covers the
 * upstream "omitted model inherits the parent runtime" cases; `docs` is the
 * non-reasoning fixture used by the thinking-clamp tests.
 */
export const TEST_TASK_SHORTLISTS = {
	coding: ["fake/first"],
	review: ["fake/first", "fake/second"],
	qa: ["fake/first", "fake/second", "fake/third"],
	recon: ["fake/parent"],
	architecture: ["fake/second"],
	docs: ["fake/plain"],
};
/** The same configuration for any agent directory a test switches to later. */
export function writeTestAgentConfig(target = directory): void {
	mkdirSync(join(target, "herdr-agents"), { recursive: true });
	writeFileSync(
		join(target, "herdr-agents", "config.json"),
		JSON.stringify({
			status: { enabled: true },
			models: { agents: {}, tasks: TEST_TASK_SHORTLISTS },
		}),
	);
}
writeTestAgentConfig();

process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
