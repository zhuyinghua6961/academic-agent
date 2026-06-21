import {describe, it, expect} from "vitest";
import {runAgentLoop} from "./loop.js";

describe("langgraph spike", () => {
  it("documents custom loop choice over LangGraph.js", () => {
    // Academic Agent uses a custom agent/tools/finalize loop instead of @langchain/langgraph.
    // Rationale: the Python codebase only used LangGraph for a thin 3-node ReAct cycle;
    // cancel/resume is handled via workspace events, not LangGraph checkpoints.
    // LangGraph.js remains an option for future multi-mode workflow graphs.
    expect(typeof runAgentLoop).toBe("function");
  });
});
