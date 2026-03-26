---
name: develop-pi-flows
description: Research, implement, verify, and fix changes to the pi-flows package
task_required: true
task_prompt: "Describe the pi-flows change to implement:"
max_concurrent: 1
---

## research
agent: pi-flows-researcher
task: >
  Research the pi-flows codebase and pi-coding-agent SDK to understand
  the area relevant to this task:

  {task}

  Focus on source files, types, and patterns directly related to the change.

## implement
agent: pi-flows-implementer
blockedBy: research
task: >
  {task}
inputs:
  research_output: "{result.research.summary}"

## verify
agent: pi-flows-verifier
blockedBy: implement
task: >
  Verify the implementation of: {task}
inputs:
  research_output: "{result.research.summary}"

## fix
agent: pi-flows-fixer
blockedBy: verify
task: >
  Fix issues found in the implementation of: {task}
inputs:
  research_output: "{result.research.summary}"
  verification_output: "{result.verify.summary}"

## agent-loop-decision: verify-fix-loop
agent: flow-decision
task: >
  Evaluate the verification result: {result.verify.summary}

  If the verifier reported FAIL with error-severity issues, choose "loop"
  to run another fix and verify cycle.
  If the verifier reported PASS or only warnings, choose "exit".

  This is iteration {loop.verify-fix-loop.iteration} of {loop.verify-fix-loop.max}.
loop_target: verify
exit_target: done
max_iterations: 2

## done
agent: pi-flows-researcher
task: >
  Summarize what was accomplished. Read the final state of the changed files
  and produce a brief summary of all changes made for: {task}
