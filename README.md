# Xpro

A **runnable multi-agent process** with a built-in **evaluation system**.

Xpro is not an editor. It's a process you start — from a shell, a container, or a CI job — that takes a task, works on a directory with real tools, and stops when it's done. And because an agent's own report of its work is worthless, the same core ships with an eval layer that runs each task repeatedly and scores it on the **git diff it actually produced**.

Supports the **OpenAI** and **Anthropic** protocols.

[简体中文](#简体中文)

<p align="center">
  <img src="docs/architecture.svg" alt="Xpro layered agent architecture" width="780" />
</p>

## Run it

```bash
git clone https://github.com/HopkeyEZ/Xpro.git && cd Xpro
npm install && npm run build

export XPRO_API_KEY=sk-...          # or ANTHROPIC_API_KEY / OPENAI_API_KEY
export XPRO_ROOT=/path/to/your/repo

node dist/runtime/cli.js run "Add unit tests for the parser and make them pass"
```

Three ways to run the same loop:

| Command | Shape | Use |
|---|---|---|
| `xpro run "<task>"` | one turn, then exit — non-zero exit if the loop didn't finish cleanly | scripts, CI steps, cron |
| `xpro serve --port 8787` | long-lived HTTP process, SSE event stream per turn | a backend driving agents |
| `xpro eval <suite.json>` | N independent rollouts per prompt, scored, report written | knowing whether the above is any good |

All configuration is environment variables, so the process containerises without a config file:

```
XPRO_PROVIDER   openai | anthropic          (default: anthropic)
XPRO_BASE_URL   API base
XPRO_API_KEY    key
XPRO_MODEL      model id
XPRO_MODE       default | acceptEdits | plan | bypass
XPRO_ROOT       workspace root             (default: cwd)
```

### As a service

```bash
node dist/runtime/cli.js serve --port 8787

curl -X POST localhost:8787/sessions -d '{"root":"/srv/repo","mode":"acceptEdits"}'
# → {"id":"..."}
curl -N -X POST localhost:8787/sessions/<id>/messages -d '{"input":"fix the failing test"}'
# → SSE: tool_call / tool_result / text / result
```

Sessions hold their history, so the second message continues the first. `GET /health` reports the model, mode, root and live session count.

## The evaluation system

An agent that says *"I've fixed the bug and added tests"* has told you nothing. Xpro's eval layer is built on three commitments:

1. **Reproducible environment.** Every rollout starts from the same pristine commit, so two runs differ because of the agent, not leftover state.
2. **Repeated rollouts.** The same prompt runs N times independently. One run measures luck; the *spread* across runs measures reliability — which is what you actually ship on.
3. **Artifact-grounded scoring.** The scorer is shown the git diff, never the agent's self-report, and must write down a reason — so a score can be argued with instead of merely trusted.

```bash
XPRO_ROOT=/path/to/repo node dist/runtime/cli.js eval evals/starter.json --rollouts 3 --out report.md
```

```
add-tests            #0 → 4/5  (7 rounds, end_turn)
add-tests            #1 → 2/5  (11 rounds, max_rounds)
extract-duplication  #0 → 4/5  (5 rounds, end_turn)
...

| case                | mean | stddev | completion |
|---------------------|------|--------|------------|
| add-tests           | 3.00 |   1.00 |       50%  |
| extract-duplication | 4.00 |   0.00 |      100%  |
```

The **stddev column is the point**. A 4.0-mean agent that swings between 2 and 5 is worse than a steady 3.5 — you can't build on a coin flip.

A suite is plain JSON. Mark where each prompt came from: `repo`-derived tasks keep you honest (you didn't write them to flatter the agent), `authored` ones probe a specific weakness. A good suite has both.

```json
{
  "id": "my-repo",
  "cases": [
    { "id": "add-tests", "origin": "repo",
      "prompt": "Find the module with the weakest test coverage, add tests, make them pass." },
    { "id": "restraint", "origin": "authored",
      "prompt": "Run the tests. Fix the cause of any failure — not the test. If all pass, change nothing." }
  ]
}
```

The scoring loop is swappable: `llmJudge` is the default, but `Scorer` is a plain function, so a suite can score on `npm test` exit codes, a lint delta, or benchmark timings instead. So is `Workspace` — the shipped one is git, but containers or VMs implement the same two methods (`reset`, `diff`).

## Architecture

Six layers, bottom to top. Each talks only to the one below, so **adding a tool never touches permission logic, and swapping a provider never touches the agent loop**.

| Layer | Responsibility | Code |
|-------|----------------|------|
| **Runtime** | CLI, HTTP server, headless toolset | `src/runtime` |
| **Eval** | workspaces, rollouts, scorers, reports | `src/framework/eval` |
| **Session** | history, compaction, checkpoints, resume | `src/framework/session` |
| **Orchestration** | agent loop, sub-agent dispatch, background tasks | `src/framework/orchestration` |
| **Policy** | permission modes, hooks, sandbox, allowlists | `src/framework/policy` |
| **Tools** | read/write/edit/search/run_command + MCP | `src/framework/tools` |
| **Model** | Messages API — tools / thinking / effort / caching (OpenAI · Anthropic) | `src/framework/model` |

At the heart is the agent loop — strip every wrapper away and it's just: call the model with the tools, run the tool calls it asks for, pair every result back by id, repeat until it's done. Everything else (round caps, permission gates, sub-agent isolation, compaction) is that loop made safe to leave unattended.

Two properties matter more in a headless process than in a desktop app, because nobody is watching the screen:

- **Every path is confined to the workspace root.** A model that talks itself into `../../../../etc/passwd` gets an error, not a file.
- **Approval lives in the policy layer, not in each tool.** One gate to audit instead of a per-tool patchwork; `plan` mode makes an agent structurally read-only, which is how the eval judge is prevented from "fixing" what it grades.

## Embed it (SDK)

The core has no dependencies beyond global `fetch`, so it drops into any service:

```ts
import { createAgent, defineTool } from 'xpro';

const placeOrder = defineTool({
  name: 'place_order',
  description: 'Place an order in the shop backend',
  parameters: {
    type: 'object',
    properties: { sku: { type: 'string' }, qty: { type: 'number' } },
    required: ['sku', 'qty'],
  },
  mutates: true,                                  // → the policy layer gates it
  handler: async ({ sku, qty }) => `ordered ${qty} × ${sku}`,
});

const agent = createAgent({
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-sonnet-4',
  mode: 'default',
  tools: [placeOrder],
});

const { finalText } = await agent.run('Order 2 units of SKU-42 and confirm');
```

Your own tools can be evaluated the same way — `runEvaluation` only needs a `Workspace` and a `Scorer`, neither of which is code-specific.

## Capabilities

- **Autonomous agent loop** — call tools, execute, verify, until the goal is met
- **Built-in evaluation** — repeated rollouts, diff-grounded scoring, mean + variance reporting
- **Sub-agent isolation** — dispatch child agents; the parent only receives the summary
- **Cross-session memory** — extract, store, recall across runs (recall / forget / supersede)
- **Pluggable tool registry** — your own tools; MCP-compatible external tools
- **Policy & approval gates** — enforced at the execution layer, not in the prompt
- **Session management** — history, compaction, checkpoints, resume
- **Unified model layer** — OpenAI and Anthropic behind one interface
- **Interruptible + background tasks** — abort or background a long run without losing state

## Desktop IDE (optional surface)

The Electron IDE is still in the tree as one front-end over the same core, no longer the main event:

```bash
npm run ide:build && npm run ide       # or: npm run ide:dev
npm run ide:dist                       # NSIS installer
```

It needs Rust 1.70+ for the `napi-rs` native module (`cd native && npm install && npm run build`). The runtime process needs only Node 18+.

## Contributing

Pull requests welcome — see the [open issues](https://github.com/HopkeyEZ/Xpro/issues). New eval cases are as valuable as new features.

> **Note:** Not affiliated with OpenAI or Anthropic.

## License

[MIT](LICENSE)

---

<a name="简体中文"></a>

## 简体中文

Xpro 是一套**可运行的多智能体进程**，自带**评测体系**。

它不是编辑器。它是一个你可以启动的进程——在 shell、容器或 CI 里——接收任务，用真实工具在一个目录上干活，干完退出。而由于 Agent 自己汇报的"我做完了"毫无价值，同一套内核还带一层评测：把每个任务**重复跑 N 次**，只根据它真正留下的 **git diff** 打分。

仅支持 **OpenAI** 与 **Anthropic** 协议。

### 跑起来

```bash
npm install && npm run build
export XPRO_API_KEY=sk-...
export XPRO_ROOT=/path/to/your/repo

node dist/runtime/cli.js run "给 parser 补单测并跑通"
node dist/runtime/cli.js serve --port 8787
node dist/runtime/cli.js eval evals/starter.json --rollouts 3
```

同一个循环的三种形态：`run` 跑一轮就退出（循环没干净结束时退出码非 0，CI 可以直接卡）；`serve` 常驻在 HTTP 后面，每轮以 SSE 推事件；`eval` 反复跑并打分——只有它能告诉你前两个到底行不行。

全部配置走环境变量（`XPRO_PROVIDER` / `XPRO_BASE_URL` / `XPRO_API_KEY` / `XPRO_MODEL` / `XPRO_MODE` / `XPRO_ROOT`），不需要配置文件，可直接塞进容器。

### 评测体系

三条原则：

1. **环境可复现** — 每次 rollout 都从同一个干净 commit 开始，两次结果不同只能是 Agent 的差异，不是残留状态。
2. **重复采样** — 同一个 prompt 独立跑 N 次。跑一次测的是运气，**次数之间的方差**测的才是可靠性。
3. **凭产物打分** — 打分者只看 git diff，看不到 Agent 的自我汇报，并且必须写下理由——这样分数是可以被反驳的，而不是只能被相信。

报告里 **stddev 那一列才是重点**：一个均分 4.0、但在 2 和 5 之间横跳的 Agent，比稳定 3.5 的更不能用——你没法在抛硬币上盖房子。

用例集就是一份 JSON。标注 prompt 的来源：`repo`（仓库本身隐含的任务，你没法为了讨好 Agent 而写）和 `authored`（你为了戳某个弱点专门写的），好的用例集两者都有。

打分器和工作区都可替换：`llmJudge` 只是默认实现，`Scorer` 就是个普通函数，也可以拿 `npm test` 退出码、lint 差值或跑分耗时来打分；`Workspace` 目前是 git 实现，容器 / 虚拟机实现同样的 `reset` / `diff` 两个方法即可接入。

### 分层架构

自底向上，每层只与下一层交互——**新增工具不改权限逻辑，更换模型不改 agent loop**：

- **运行时层** — CLI、HTTP 服务、无头工具集（`src/runtime`）
- **评测层** — 工作区、rollout、打分器、报告（`src/framework/eval`）
- **会话层** — 历史、compaction、检查点、resume
- **编排层** — agent loop、子 agent 派发、后台任务
- **策略层** — 权限模式、钩子、沙箱、允许列表（门设在执行层，不在提示词）
- **工具层** — read/write/edit/search/run_command + MCP 外部工具
- **模型层** — Messages API（tools / thinking / effort / caching）

无头进程里有两件事比桌面端更要紧，因为没人盯着屏幕：**所有路径都被限制在 workspace 根目录内**（模型把自己说服到 `../../../../etc/passwd` 时拿到的是报错，不是文件）；**审批统一收在策略层**，而不是散在每个工具里——只有一道门要审计，而且 `plan` 模式让 Agent 结构性只读，评测里的裁判就是靠这个防止它去"修好"自己要打分的东西。

### 作为 SDK 嵌入

内核除了全局 `fetch` 零依赖，可以直接塞进任何服务：

```ts
import { createAgent, defineTool } from 'xpro';

const agent = createAgent({
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-sonnet-4',
  tools: [ /* 你的业务工具 */ ],
});

await agent.run('帮我处理订单 #1234 的退款并通知买家');
```

你自己的业务工具也能用同一套评测衡量——`runEvaluation` 只要一个 `Workspace` 和一个 `Scorer`，两者都跟"写代码"这件事无关。

### 桌面 IDE（可选形态）

Electron IDE 仍在仓库里，作为同一内核之上的一个前端，不再是主角：`npm run ide:build && npm run ide`，打包用 `npm run ide:dist`。它需要 Rust 1.70+ 编译 napi-rs 原生模块；而运行时进程只需要 Node 18+。
