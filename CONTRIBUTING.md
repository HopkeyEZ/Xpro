# Contributing to Xpro

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

Node 18+ is all the runtime needs. Rust is only required for the optional Electron IDE.

```bash
git clone https://github.com/HopkeyEZ/Xpro.git
cd Xpro
npm install

npm run build                 # runtime + framework → dist/
node dist/runtime/cli.js --help
```

Working on the Electron IDE instead:

```bash
cd native && npm install && npm run build && cd ..
npm run ide:build && npm run ide
```

## Project Structure

- `src/runtime/` — the runnable process: CLI (`run` / `serve` / `eval`) and the headless toolset
- `src/framework/` — the reusable core: `model` · `tools` · `policy` · `orchestration` · `session` · `eval`
- `evals/` — evaluation suites (plain JSON)
- `examples/` — standalone scripts, e.g. `eval-repo.ts`
- `src/main/`, `src/renderer/`, `native/` — the optional Electron IDE front-end

## Before You Submit

Type-check what you touched, and — if you changed anything in the loop, the tools or the policy layer — run the eval suite against a real repo and put the numbers in the PR:

```bash
npx tsc -p tsconfig.runtime.json --noEmit
XPRO_ROOT=/path/to/a/repo node dist/runtime/cli.js eval evals/starter.json --rollouts 3
```

A change that raises the mean but also raises the stddev is usually a regression, not an improvement — an agent you can't predict is an agent you can't build on. Say so in the PR rather than reporting the mean alone.

## How to Contribute

1. Fork the repo and create a branch from `master`
2. Make your changes
3. Type-check, and run the evals if the change could affect agent behaviour
4. Submit a pull request

New eval cases are as welcome as new features. Mark each case's `origin`: `repo` for tasks the codebase itself implies, `authored` for ones written to probe a specific weakness.

## Guidelines

- Keep PRs focused — one feature or fix per PR
- Follow existing code style
- The framework core depends on nothing but global `fetch` — keep it that way; inject Node APIs (see how `Exec` is passed into the eval layer) instead of importing them
- Write clear commit messages

## Bug Reports

Open an [issue](https://github.com/HopkeyEZ/Xpro/issues) with:
- Steps to reproduce
- Expected vs actual behavior
- OS version and Xpro version

## Feature Requests

Open an [issue](https://github.com/HopkeyEZ/Xpro/issues) describing the feature and why it would be useful.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
