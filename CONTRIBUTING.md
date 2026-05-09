# Contributing to Xpro

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/HopkeyEZ/Xpro.git
cd Xpro
npm install

# Build Rust native module
cd native && npm install && npm run build && cd ..

# Dev mode
npm run build:main
npm start
```

## Project Structure

- `src/main/` — Electron main process (TypeScript)
- `src/renderer/` — Electron renderer (TypeScript + Webpack)
- `native/` — Rust native module (napi-rs)

## How to Contribute

1. Fork the repo and create a branch from `master`
2. Make your changes
3. Test locally with `npm run build:main && npm start`
4. Submit a pull request

## Guidelines

- Keep PRs focused — one feature or fix per PR
- Follow existing code style
- Test your changes before submitting
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
