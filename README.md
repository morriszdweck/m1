# M1

A private AI agent for your Mac or Linux computer that runs **K2 Horizon 3.7B** entirely on your computer, with a clean web interface in your browser.

- **Chat** with full Markdown: tables, code with highlighting and copy buttons, math, task lists.
- **Does things on your computer**: runs commands, reads and writes files, searches and reads the web, opens apps and links, sets reminders, uses the clipboard, and clicks around websites with [Betterwright](https://www.npmjs.com/package/betterwright).
- **Thinks first, as much as you want**: K2 Horizon 3.7B reasons before it answers. The **reasoning effort** slider under the message box picks Low (quick), Medium or High (thinks as long as it needs). The reasoning stays folded away; tap it to read it.
- **Text in, text out**: attach text files and documents (PDF, Word, code, CSV and more). No voice or pictures.
- **Three safety modes**: *Ask for Approval*, *Approve for Me* and *Full Auto*. Approve for Me needs the [Auto 150M](https://huggingface.co/ProCreations/auto-150m-3) classifier, which approves safe actions and asks you about the rest; picking it downloads Auto 150M first. Commands that could wipe data always ask.
- **Choose project**: the button under the message box ties a chat to one folder. The agent then works only there: file tools refuse paths outside it, and shell commands run in a sandbox that can write only inside the folder and can't read the rest of your home folder (`sandbox-exec` on macOS, [bubblewrap](https://github.com/containers/bubblewrap) on Linux; without bubblewrap, commands that name a path outside the folder are refused and every command asks you first). Recent projects are one click away.
- **Memory and For You**: it learns small facts about you, uses only the relevant ones (to keep prompts short) and suggests ideas based on them.
- **Routines** you can run with one click or on a schedule, and an **Activity** log of every action and who approved it.
- **One-click downloads** inside the app, with a choice of model size (Smaller, Balanced, Best, or any GGUF quant in Settings). The app still routes each message itself.

Everything stays on your computer. The only network traffic is the one-time downloads and web searches you ask for.

## Install

On a Mac, download the app and drag it to Applications:

- [M1 for Apple silicon](https://github.com/morriszdweck/m1/releases/latest/download/M1-arm64.dmg)
- [M1 for Intel](https://github.com/morriszdweck/m1/releases/latest/download/M1-x64.dmg)

The app isn't notarized yet, so macOS blocks it the first time. Either install with the Terminal command below instead, or open System Settings → Privacy & Security, scroll down and click **Open Anyway**. On first launch it installs M1 (the same copy the command below installs) and shows the setup screen.

Or paste this into Terminal on macOS, or a terminal on Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/morriszdweck/m1/main/install.sh | bash
```

It installs a ready-to-run copy in `~/.m1` (no npm or build step, and a private copy of Node.js if you don't have one), adds **M1** to your app menu on Linux and a `m1` command, then opens the setup screen at <http://127.0.0.1:8270> (in the Mac app when it's installed). Pick what to download and a model size there; that's it.

Afterwards, open it from Applications, Spotlight or your app menu, or with `m1`. The Mac app is a window onto that same copy (`desktop/`), so it updates along with it. `m1 stop` stops it.

It keeps itself up to date: every push to `main` is published as a release, new versions download in the background and go in when nothing is running, and if one doesn't start the previous version comes back. Turn this off in Settings → General; `m1 update` gets the newest version right away.

Requirements: an Apple silicon Mac with macOS 14 or later, or a 64-bit Linux computer (see [Linux](#linux)), and about 4 GB of free space for everything (about 2.7 GB for chat only).

From a clone instead (it won't update itself; use `git pull`): double-click **M1.command** on macOS, run `scripts/start.sh`, or run `npm ci && npm run build && npm start` (Node.js 22 or newer).

## Linux

The same command installs it on Linux. It needs a 64-bit Intel, AMD or ARM computer with glibc 2.35 or newer (Ubuntu 22.04, Debian 12, Fedora 36 or later, and most distributions since 2022). It keeps its files in `~/.local/share/m1` (or `$XDG_DATA_HOME/m1`) and adds a `.desktop` entry to your app menu.

**Speed.** The AI engine picks the fastest build it can use:

- **Vulkan** when your graphics driver supports it (most AMD, Intel and NVIDIA GPUs with current drivers). Nothing extra to install.
- **CPU** otherwise. It works everywhere, just slower.
- **CUDA** for NVIDIA cards, if you ask for it with `M1_GPU=cuda m1` (driver 525 or newer). It downloads about 600 MB more.

`M1_GPU=vulkan` or `M1_GPU=cpu` picks one of the others; then remove and reinstall the AI engine in Settings → Downloads. If the GPU build can't start a model, M1 restarts it on the CPU by itself.

**Optional extras.** Everything works without these. They add the clipboard, document conversion and reminder pop-ups. On Ubuntu and Debian (other distributions have the same packages, with `libnotify` in place of `libnotify-bin`):

```bash
sudo apt install wl-clipboard xclip libnotify-bin pandoc
```

**Not yet on Linux:** the Web helper's browser needs an x86_64 computer, and the safety helper uses the CPU version of PyTorch.

## What gets downloaded

| Part | What it is | Size |
| --- | --- | --- |
| AI engine | [llama.cpp](https://github.com/ggml-org/llama.cpp) server, latest release | ~30 MB |
| Brain | [K2 Horizon 3.7B](https://huggingface.co/IFM/K2-Horizon-3.7B-GGUF) (GGUF, Q4_K_M to BF16; Q5_K_M by default) | 2.5–7.5 GB |
| Safety helper | Auto 150M, run with Python through `uv` | ~1.1 GB |
| Web helper | Betterwright and its browser | ~250 MB |

Files live in `~/Library/Application Support/M1` on macOS and `~/.local/share/m1` on Linux. Settings → Downloads switches model sizes (the old size keeps answering until the new one is ready) and removes any part.

**Advanced: your own model.** Settings → Advanced → Brain model → **Use a model from Hugging Face** takes a link such as `https://huggingface.co/<org>/<model>-GGUF`. M1 reads the repository's GGUF list, groups split files, picks a size that should fit this computer, checks the GGUF header and chat template, and runs it on the same llama.cpp engine. A `blob` link to one `.gguf` file preselects that file. Public repositories work directly; for a gated or private one, accept its terms on Hugging Face and set `HF_TOKEN` (or `HUGGING_FACE_HUB_TOKEN`) before starting M1. Only text GGUF models are used here. Switch back to the built-in K2 Horizon 3.7B at any time. A model you add hasn't been tested with M1's tools, so while it answers, Full Auto works like Approve for Me and Auto 150M checks each action.

## How it works

```
browser ──HTTP/WebSocket──▶ server/ (Node, 127.0.0.1:8270)
                              ├─ llama-server  Brain          :8280  (K2 Horizon 3.7B or your GGUF)
                              ├─ guardian/     Auto 150M      :8776
                              └─ bridge/       Betterwright   :8777
```

- `server/agent.js` runs the agent loop. K2 Horizon writes tool calls in its native `<ifm|tool_call>` format and its thinking in `<ifm|think>` tags (`server/think.js`); the reasoning effort goes to its chat template; `server/toolparser.js` reads that and the other common forms.
- `server/models.js` reads Hugging Face links, finds and groups GGUF files, picks a size for this computer and checks a model's header before it runs.
- `server/prompt.js` keeps prompts small: a short system prompt, only relevant memories, and older tool results trimmed to fit the context budget.
- `web/` is a React app built with Vite into `web/dist`, which the server hosts.

The server only accepts requests from this computer, from its own page, carrying a token that changes every launch.

## Develop

```bash
npm ci
npm run dev        # rebuilds the UI and restarts the server on changes
npm run typecheck
npm test           # starts the server and checks its API
node scripts/bundle.mjs --build 1   # packs release/m1.tar.gz and latest.json, as CI does for releases
```

## License

MIT
