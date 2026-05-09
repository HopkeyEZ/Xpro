# ✦ Xpro

**AI-Powered IDE with Agent Mode — Supports DeepSeek / OpenAI / Anthropic**

> An Electron-based AI coding IDE featuring autonomous agent mode, project memory system, sub-agents, visual annotation, and full DeepSeek API compatibility (including thinking mode).

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Electron 31 |
| 前端 | TypeScript + Monaco Editor |
| 原生性能模块 | Rust (napi-rs) |
| AI 通信 | OpenAI / Anthropic SSE 流式协议 |
| 打包 | electron-builder |

## 功能特性

### 代码编辑
- Monaco Editor（VS Code 同款编辑器内核）
- 多语言语法高亮（Rust, Python, TypeScript, Java, Go, C/C++ 等）
- 多标签页编辑，支持新建 / 关闭 / 切换
- 文件自动语言检测

### 文件管理
- 左侧文件树浏览器，支持展开/折叠
- 打开文件夹，自动过滤 node_modules / .git / target 等
- 文件图标按语言区分

### AI 助手
- **DeepSeek** — 完整支持 deepseek-v4-pro / deepseek-v4-flash，含思考模式 (Thinking Mode)
- **OpenAI 协议** — 兼容 GPT 系列及第三方兼容 API
- **Anthropic 协议** — 支持 Claude 系列模型
- Agent 模式 — 自主执行工具调用（读写文件、执行命令、搜索代码）
- Sub-Agent 并行 — 多个子代理同时工作
- 项目记忆系统 — 跨会话记住项目上下文
- 可视化标注 — 截图圈画让 AI 直接修改对应代码
- SSE 流式实时输出
- Markdown 代码块渲染

### Rust 原生加速
- **文件搜索** — 基于 walkdir，高速遍历项目文件
- **文本搜索** — 类 ripgrep 全文检索
- **Diff 计算** — 行级快速差异比对
- 通过 napi-rs 桥接到 Node.js

### 界面
- 暗色主题（PyOneDark 风格）
- 三栏布局：文件树 | 编辑器+终端 | AI 助手
- 可拖拽分栏调整宽度/高度
- 底部状态栏（文件路径、语言、光标位置）

---

## 项目结构

```
Xpro/
├── package.json                # 项目配置 & 依赖
├── tsconfig.main.json          # 主进程 TS 配置
├── tsconfig.renderer.json      # 渲染进程 TS 配置
├── webpack.renderer.js         # 渲染进程打包配置
│
├── src/
│   ├── main/                   # Electron 主进程 (TypeScript)
│   │   ├── index.ts            #   应用入口
│   │   ├── window.ts           #   窗口管理
│   │   ├── preload.ts          #   预加载脚本 (contextBridge)
│   │   ├── ipc.ts              #   IPC 处理器
│   │   ├── ai-bridge.ts        #   AI 协议桥接 (OpenAI + Anthropic)
│   │   └── config.ts           #   配置读写
│   │
│   └── renderer/               # Electron 渲染进程 (TypeScript)
│       ├── index.html          #   主页面
│       ├── index.ts            #   渲染入口
│       ├── styles/
│       │   └── main.css        #   全局暗色主题
│       ├── components/
│       │   ├── Editor.ts       #   Monaco 代码编辑器
│       │   ├── FileTree.ts     #   文件树面板
│       │   ├── AiPanel.ts      #   AI 对话面板
│       │   ├── Terminal.ts     #   终端面板
│       │   ├── StatusBar.ts    #   状态栏
│       │   └── Resizer.ts      #   分栏拖拽
│       └── services/
│           └── ConfigService.ts#   配置服务
│
└── native/                     # Rust 原生模块 (napi-rs)
    ├── Cargo.toml
    ├── package.json
    ├── build.rs
    └── src/
        ├── lib.rs              #   导出接口
        ├── search.rs           #   文件/文本搜索
        └── diff.rs             #   差异计算
```

---

## 快速开始

### 环境要求

| 依赖 | 版本 |
|------|------|
| Node.js | 18+ |
| Rust | 1.70+ |
| npm | 9+ |

### 安装

```bash
cd Xpro
npm install

# 构建 Rust 原生模块
cd native
npm install
npm run build
cd ..
```

### 开发运行

```bash
npm run build:main
npm start
```

### 打包

```bash
npm run build
npm run dist
```

---

## AI 配置

在应用内点击「Settings」按钮，填写：

| 参数 | 说明 |
|------|------|
| 协议 | `openai` 或 `anthropic` |
| API 地址 | 如 `https://api.deepseek.com`、`https://api.openai.com/v1` |
| API Key | 你的密钥 |
| 模型 | 如 `deepseek-v4-flash`、`gpt-4o`、`claude-sonnet-4-20250514` |
| Thinking Mode | 勾选开启深度思考（DeepSeek） |

配置保存在 `~/.xpro/config.json`。

### DeepSeek 快速配置

| 字段 | 值 |
|------|------|
| Protocol | OpenAI |
| Base URL | `https://api.deepseek.com` |
| Model | `deepseek-v4-flash` 或 `deepseek-v4-pro` |

---

## 作者

**Hopkey**

## License

MIT
