# Skills Protocol Through Codex Proxy

Status: active
Verified against production: 2026-03-30

## Summary

OpenAI Skills (versioned bundles of files + `SKILL.md` manifest) work through the Codex proxy, but NOT via the official OpenAI API format (`type: "shell"` + `environment.skills`). The ChatGPT Codex backend rejects those tool types.

The working approach mirrors how the official Codex CLI implements skills: a **function tool named `"shell"`** that the client executes locally, plus skill metadata injected into `instructions`.

## What Does NOT Work Through Codex Backend

The ChatGPT Codex backend (`chatgpt.com/backend-api/codex/responses`) rejects all official OpenAI Skills API formats:

| Format | Error |
|--------|-------|
| `type: "shell"` + `environment.skills` (hosted) | `Unsupported tool type: shell` |
| `type: "shell"` + `environment.skills` (local) | `Unsupported tool type: shell` |
| `type: "inline"` (base64 zip) | `Unsupported tool type: inline` |
| `type: "local_shell"` + `skills` param | `Unknown parameter: tools[0].skills` |
| `type: "local_shell"` + `environment` | `Unknown parameter: tools[0].environment` |
| Top-level `skills` field on request | `Unsupported parameter: skills` |
| `type: "skill"` / `"skill_reference"` / `"container_shell"` | `Unsupported tool type` |

These formats only work via `api.openai.com` with a regular OpenAI API key.

## What Works: Function Tool `"shell"` (GPT-5.x Pattern)

This is how the official Codex CLI implements skills with current GPT-5.x models. The model calls a regular function tool, the client executes the command locally.

### Tool Definition

```json
{
  "type": "function",
  "name": "shell",
  "description": "Runs a command on the local system. Each element in the command array is a separate argument passed to execvp. Prefer [\"bash\", \"-lc\", \"your command\"] for shell scripts.",
  "parameters": {
    "type": "object",
    "properties": {
      "command": {
        "type": "array",
        "items": { "type": "string" },
        "description": "The command to run as an array of arguments."
      },
      "workdir": {
        "type": "string",
        "description": "Working directory. Defaults to current directory."
      },
      "timeout_ms": {
        "type": "number",
        "description": "Timeout in milliseconds."
      }
    },
    "required": ["command"]
  }
}
```

### Skill Injection via Instructions

Add skill metadata to the `instructions` field:

```
You have access to the following skills:

- **basic-math** -- Add or multiply numbers using Python. Path: /tmp/skills/basic-math
- **eve-market** -- Analyze EVE market data. Path: /opt/eveai/skills/eve-market

Before using a skill, read its SKILL.md to learn how to use it.
Use the shell tool to execute commands locally.
```

### Execution Flow

```
1. User: "Add 144 + 377 using basic-math skill"

2. Model -> function_call: shell(["bash", "-lc", "cat /tmp/skills/basic-math/SKILL.md"])
   Client executes, returns SKILL.md contents

3. Model -> function_call: shell(["bash", "-lc", "python3 /tmp/skills/basic-math/calculate.py \"144 + 377\""])
   Client executes, returns "Result: 521"

4. Model -> message: "144 + 377 = 521"
```

GPT-5.x models can combine `cat SKILL.md && ls` into a single call, reducing round-trips from 4 to 3.

### Input Format for Tool Loop

Return shell output as standard `function_call_output`:

```json
[
  {"role": "user", "content": [{"type": "input_text", "text": "user question"}]},
  {
    "type": "function_call",
    "id": "fc_001",
    "call_id": "call_001",
    "name": "shell",
    "arguments": "{\"command\":[\"bash\",\"-lc\",\"cat /tmp/skills/basic-math/SKILL.md\"]}",
    "status": "completed"
  },
  {
    "type": "function_call_output",
    "call_id": "call_001",
    "output": "---\nname: basic-math\n..."
  }
]
```

## What Works: `type: "local_shell"` (Codex-Mini Pattern)

Older codex models support a native `local_shell` tool type. Same concept but different protocol.

### Tool Definition

```json
{ "type": "local_shell" }
```

No parameters on the tool. The model outputs `local_shell_call` items, and the client returns `local_shell_call_output`.

### Input Format for Tool Loop

```json
[
  {"type": "local_shell_call", "id": "lsh_001", "call_id": "call_001", "status": "completed",
   "action": {"command": ["bash", "-lc", "cat SKILL.md"], "env": {}, "type": "exec"}},
  {"type": "local_shell_call_output", "call_id": "call_001", "output": "..."}
]
```

## Model Compatibility Matrix

| Model | Function tool `"shell"` | Native `local_shell` |
|-------|------------------------|---------------------|
| gpt-5.5 | **works** | not supported |
| gpt-5.4 | **works** | not supported |
| gpt-5.4-mini | **works** | not supported |
| gpt-5.3-codex | **works** | not supported |
| gpt-5.2-codex | **works** | **works** |
| gpt-5.1-codex-max | **works** | **works** |
| gpt-5.1-codex-mini | **works** | **works** |

The function tool approach works on ALL models. Use it as the default.

## SKILL.md Manifest Format

Compatible with the [Agent Skills standard](https://agentskills.io/specification):

```markdown
---
name: basic-math
description: Add or multiply numbers using Python.
---

When you need to add or multiply numbers, run `python3 /path/to/calculate.py <expression>`.

Example: `python3 /path/to/calculate.py "144 + 377"`

Always use this skill for arithmetic instead of guessing.
```

Front matter requires `name` and `description`. File matching is case-insensitive. One `SKILL.md` per skill directory.

## Security

The client executes shell commands from the model. Mandatory safeguards:

- **Sandbox**: Run commands in a restricted environment (seccomp, Landlock, or container)
- **Allowlist**: Only permit commands within skill directories
- **Timeout**: Enforce per-command timeout (10s default in Codex CLI)
- **Output cap**: Truncate stdout/stderr to prevent context overflow (Codex CLI caps at 256KB)
- **No secrets**: Skills must not have access to auth tokens, `.env`, or database files

## Codex CLI Tool Catalog (All Work Through Proxy as Function Tools)

Everything below is a standard `type: "function"` tool. The model calls it, the client executes and returns the result. This is the active GPT-5.x-compatible path through the Codex proxy.

### shell -- Local Command Execution

Runs commands on the host system. Core tool for skills execution.

Codex CLI defines three variants:
- `shell` -- array of arguments for execvp: `["bash", "-lc", "your command"]`
- `shell_command` -- string passed to user's default shell
- `exec_command` -- PTY-based with streaming output, yield_time_ms, max_output_tokens, session_id

```json
{
  "type": "function",
  "name": "shell",
  "description": "Runs a command on the local system. Prefer [\"bash\", \"-lc\", \"your command\"].",
  "parameters": {
    "type": "object",
    "properties": {
      "command": { "type": "array", "items": { "type": "string" } },
      "workdir": { "type": "string" },
      "timeout_ms": { "type": "number" }
    },
    "required": ["command"]
  }
}
```

EVE bot use: skills execution, data scripts, file operations.

### spawn_agent -- Sub-Agent Spawning

Spawns an independent sub-agent for a bounded task. Returns agent_id. Use with `send_message`/`assign_task` to communicate, `wait_agent` to block until done, `close_agent` to terminate.

```json
{
  "type": "function",
  "name": "spawn_agent",
  "description": "Spawn a sub-agent for a bounded task. Returns agent_id and task_name.",
  "parameters": {
    "type": "object",
    "properties": {
      "task_name": { "type": "string", "description": "Short canonical name for the task" },
      "prompt": { "type": "string", "description": "Full instructions for the sub-agent" },
      "model": { "type": "string", "description": "Model to use (optional)" }
    },
    "required": ["task_name", "prompt"]
  }
}
```

Related agent management tools from Codex CLI:
- `send_message` -- add message to agent without triggering a turn
- `assign_task` -- add message AND trigger agent execution
- `wait_agent` -- block until agent reaches final status or timeout
- `close_agent` -- shut down agent and its descendants
- `list_agents` -- list live agents with optional task-path filtering
- `resume_agent` -- reactivate a closed agent

EVE bot use: "Analyze my fleet" spawns one agent per pilot in parallel. "Compare market in Jita vs Amarr" spawns two agents. Complex multi-step workflows where each step is independent.

### spawn_agents_on_csv -- Batch Processing

Processes a CSV file by spawning one worker agent per row. The instruction template supports `{column_name}` placeholders. Waits until all workers complete.

```json
{
  "type": "function",
  "name": "spawn_agents_on_csv",
  "description": "Process a CSV file by spawning one worker agent per row. Template uses {column} placeholders.",
  "parameters": {
    "type": "object",
    "properties": {
      "csv_path": { "type": "string", "description": "Path to the CSV file" },
      "instruction_template": { "type": "string", "description": "Instruction template with {column} placeholders" },
      "max_concurrency": { "type": "number", "description": "Max parallel workers (default 16)" },
      "timeout_per_worker": { "type": "number", "description": "Per-worker timeout in seconds (default 1800)" }
    },
    "required": ["csv_path", "instruction_template"]
  }
}
```

Workers report results via `report_agent_job_result` tool. Output is exported to CSV.

EVE bot use: mass price check for shopping list, bulk killboard analysis for corp members, fleet composition analysis from CSV export.

### request_user_input -- Structured Choices

Shows structured questions with multiple-choice options. Renders as buttons/choices in UI (Telegram inline keyboard).

```json
{
  "type": "function",
  "name": "request_user_input",
  "description": "Show structured questions with multiple-choice options to the user.",
  "parameters": {
    "type": "object",
    "properties": {
      "questions": {
        "type": "array",
        "description": "1-3 questions to show",
        "items": {
          "type": "object",
          "properties": {
            "id": { "type": "string", "description": "Stable snake_case identifier" },
            "header": { "type": "string", "description": "Short label (12 chars max)" },
            "question": { "type": "string", "description": "Single-sentence prompt" },
            "options": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "label": { "type": "string", "description": "1-5 word label" },
                  "description": { "type": "string", "description": "One sentence explaining impact" }
                }
              }
            }
          },
          "required": ["id", "question", "options"]
        }
      }
    },
    "required": ["questions"]
  }
}
```

Recommended option should have "(Recommended)" suffix and be first. Client auto-adds a free-form "Other" option.

EVE bot use: "Shortest or safest route?", "Which character?", "Include lowsec?", "What price threshold?" -- renders as Telegram inline keyboard buttons instead of free-text questions.

### js_repl -- Persistent JavaScript REPL

Persistent Node.js kernel with top-level await. State persists across calls within a session.

```json
{
  "type": "function",
  "name": "js_repl",
  "description": "Runs JavaScript in a persistent Node.js kernel with top-level await.",
  "parameters": {
    "type": "object",
    "properties": {
      "code": { "type": "string", "description": "JavaScript code to execute" }
    },
    "required": ["code"]
  }
}
```

Related: `js_repl_reset` -- restarts kernel and clears state.

EVE bot use: complex market data aggregation, profit calculations, data transformation pipelines, charting data preparation.

### list_dir -- Directory Listing

Lists entries in a local directory with pagination.

```json
{
  "type": "function",
  "name": "list_dir",
  "description": "Lists entries in a local directory with 1-indexed entry numbers and type labels.",
  "parameters": {
    "type": "object",
    "properties": {
      "dir_path": { "type": "string", "description": "Absolute path to directory" },
      "offset": { "type": "number", "description": "Entry number to start from (1+)" },
      "limit": { "type": "number", "description": "Max entries to return" },
      "depth": { "type": "number", "description": "Max directory depth to traverse (1+)" }
    },
    "required": ["dir_path"]
  }
}
```

EVE bot use: browsing skill directories, inspecting data files.

### view_image -- Local Image Viewing

Loads and returns a local image file as data URL.

```json
{
  "type": "function",
  "name": "view_image",
  "description": "Load and view a local image file.",
  "parameters": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Path to image file" },
      "detail": { "type": "string", "description": "\"original\" to preserve resolution" }
    },
    "required": ["path"]
  }
}
```

EVE bot use: viewing generated charts, map screenshots, skill-produced visualizations.

## Implementation Priority for EVE Bot

1. **request_user_input** -- highest value, lowest effort. Renders as Telegram inline keyboard. Eliminates ambiguous free-text clarification loops.
2. **shell + skills** -- enables SKILL.md-based workflows. Requires sandbox implementation.
3. **spawn_agent** -- multi-agent parallelism. Requires agent lifecycle management in executor.
4. **js_repl** -- persistent computation environment. Requires Node.js kernel management.
5. **spawn_agents_on_csv** -- batch processing. Depends on spawn_agent infrastructure.

## Reference

- [OpenAI Skills Documentation](https://developers.openai.com/api/docs/guides/tools-skills)
- [OpenAI Shell Tool Documentation](https://developers.openai.com/api/docs/guides/tools-shell)
- [Agent Skills Standard](https://agentskills.io/specification)
- [Codex CLI Source: tools/src/local_tool.rs](https://github.com/openai/codex/blob/main/codex-rs/tools/src/local_tool.rs)
- [Codex CLI Source: tools/src/tool_spec.rs](https://github.com/openai/codex/blob/main/codex-rs/tools/src/tool_spec.rs)
- [Codex CLI Source: tools/src/agent_tool.rs](https://github.com/openai/codex/blob/main/codex-rs/tools/src/agent_tool.rs)
- [Codex CLI Source: tools/src/agent_job_tool.rs](https://github.com/openai/codex/blob/main/codex-rs/tools/src/agent_job_tool.rs)
- [Codex CLI Source: tools/src/request_user_input_tool.rs](https://github.com/openai/codex/blob/main/codex-rs/tools/src/request_user_input_tool.rs)
- [Codex CLI Source: tools/src/js_repl_tool.rs](https://github.com/openai/codex/blob/main/codex-rs/tools/src/js_repl_tool.rs)
