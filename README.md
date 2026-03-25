# Antigravity Phone Connect 📱

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

**Antigravity Phone Connect** is a real-time mobile monitor and remote control for your [Antigravity](https://antigravity.google) AI sessions. Step away from your desk while keeping full sight and control of your AI's thinking and code generation — directly from your phone.

> **Note:** This project is a refined fork/extension based on the original [Antigravity Shit-Chat](https://github.com/gherghett/Antigravity-Shit-Chat) by gherghett.

---

## 📋 Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | >= 16.0 | [Download](https://nodejs.org/) |
| **Python** | >= 3.6 | Only for launcher scripts |
| **Antigravity** | Latest | Must be installed on the machine |

---

## 🚀 Quick Start

### Step 1: Clone & Install

```bash
git clone https://github.com/benjibazan/ag-phone-connect.git
cd ag-phone-connect
npm install
```

### Step 2: Configure Environment

```bash
# Create .env from template (auto-created by launcher scripts too)
cp .env.example .env    # Mac/Linux
copy .env.example .env  # Windows
```

Edit `.env` with your settings:

```env
# Required
APP_PASSWORD=your-secure-password

# Server Port (default: 3001)
PORT=3001

# Optional — auto-detected per OS if not set
# AG_BIN_PATH=/path/to/antigravity
# PROJECTS_DIR=/path/to/your/projects
```

### Step 3: Launch Antigravity in Debug Mode

The **key requirement**: Antigravity must be started with `--remote-debugging-port=9000` so the phone app can connect via Chrome DevTools Protocol (CDP).

**Windows — Option A: Using the debug bat script**
```cmd
antigravity-debug.bat C:\Proyects\my-project
```

**Windows — Option B: Right-click context menu**
```cmd
:: Run once to install the right-click menu entry
install_debug_contextmenu.bat
```
Then right-click any folder → **"Open with Antigravity (Debug)"**

**Windows — Option C: Manual**
```cmd
"%LOCALAPPDATA%\Programs\Antigravity\bin\antigravity.cmd" . --remote-debugging-port=9000
```

**macOS:**
```bash
antigravity . --remote-debugging-port=9000
# Or if not in PATH:
/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity . --remote-debugging-port=9000
```

**Linux:**
```bash
antigravity . --remote-debugging-port=9000
```

> 💡 **All windows share port 9000.** Once the first Antigravity window is launched with the flag, all subsequent windows opened from within Antigravity are automatically discoverable.

### Step 4: Start the Server

**Quick (direct Node.js):**
```bash
node server.js
```

**With launcher script (recommended — handles env setup, dependency checks, QR code):**

| OS | Local | Remote |
|---|---|---|
| Windows | `start_ag_phone_connect.bat` | `start_ag_phone_connect_web.bat` |
| macOS/Linux | `./start_ag_phone_connect.sh` | `./start_ag_phone_connect_web.sh` |

The server will:
- 🔍 Auto-discover all Antigravity windows on port 9000
- 🔌 Connect to each via CDP WebSocket
- 📸 Start capturing snapshots
- 🚀 Start HTTPS server on port 3001
- 📱 Start HTTP fallback on port 3002 (for Tailscale)
- 📱 Display your connection URL and QR code

### Step 5: Connect Your Phone

**Option A: Same Wi-Fi (HTTPS)**
1. Ensure your phone is on the **same Wi-Fi** as your computer
2. Open your mobile browser → **`https://<your-ip>:3001`** (shown in terminal)
3. Accept the self-signed certificate warning (first time only)
4. Enter your `APP_PASSWORD` if prompted

**Option B: Tailscale (recommended for remote access)**
1. Install [Tailscale](https://tailscale.com/) on your computer and phone
2. Connect both devices to your Tailscale network
3. Open **`http://<tailscale-ip>:3002`** on your phone
4. No certificate warnings — Tailscale traffic is already encrypted

---

## 🪟 Multi-Window Support

Switch between multiple Antigravity projects directly from your phone:

- **Window Tabs**: Browser-like tabs at the top. **⚡ Manager** is always first, followed by projects alphabetically
- **Long-press to Reorder**: Hold a project tab → menu appears with ⬅️ / ⬆️ First / ➡️ options. Order is saved
- **Per-Project Conversations**: Each window stores its own chat tabs separately

### Workspace Opener (Manager View)

When the **⚡ Manager** tab is active, the chat input is replaced with a workspace management panel:

- **Project Tiles**: 2-column grid showing all folders in your `PROJECTS_DIR`. Already-open projects marked ✅
- **Quick Input**: Type just a folder name (e.g., `my-project`) and it auto-prepends your `PROJECTS_DIR` path
- **One-Tap Open**: Tap any tile to open a new Antigravity window with debug port enabled

### Workflow Launcher

- Tap **⚡ Workflows** in the quick actions bar
- Shows all `.agent/workflows/*.md` files as tappable chips
- Tapping a workflow (e.g., `/fix-bug`) **inserts** it into the chat input — doesn't auto-send, so you can add context

---

## 🔒 HTTPS Setup

### Option 1: Command Line
```bash
node generate_ssl.js
```

### Option 2: Web UI
1. Start the server (HTTP)
2. Click the **"Enable HTTPS"** banner
3. Restart the server

After generating, first visit on phone → tap **"Advanced" → "Proceed to site"** (one-time).

---

## 🌍 Remote Access

### Tailscale (Recommended)

Access your Antigravity from **anywhere** — mobile data, different Wi-Fi, on the go:

1. Install [Tailscale](https://tailscale.com/) on your computer and phone
2. Both devices join the same Tailscale network (free for personal use)
3. Start the server normally: `node server.js`
4. Open **`http://<tailscale-ip>:3002`** on your phone

> 💡 The server automatically starts an HTTP fallback on port 3002 specifically for Tailscale. Since Tailscale encrypts all traffic via WireGuard, HTTPS is redundant — so you get a clean connection without certificate warnings.

### ngrok (Alternative)

If you prefer ngrok for tunnel-based access:

1. Sign up at [ngrok.com](https://ngrok.com) and get your authtoken
2. Add `NGROK_AUTHTOKEN=your-token` to `.env`
3. Run the web launcher: `./start_ag_phone_connect_web.sh` (or `.bat` on Windows)
4. Scan the **Magic QR Code** or open the public URL on your phone

---

## ⚙️ Cross-Platform Configuration

The app auto-detects paths per OS. Override via `.env` if needed:

| Variable | Windows (default) | macOS (default) | Linux (default) |
|---|---|---|---|
| `AG_BIN_PATH` | `%LOCALAPPDATA%\Programs\Antigravity\bin\antigravity.cmd` | `/Applications/Antigravity.app/.../bin/antigravity` | `antigravity` (PATH) |
| `PROJECTS_DIR` | `C:\Proyects` | `~/Projects` | `~/Projects` |
| `PORT` | `3001` | `3001` | `3001` |

### macOS: Right-Click Quick Action (Optional)

1. Open **Automator** → **File → New → Quick Action**
2. Set: "Workflow receives current" → **folders**, "in" → **Finder**
3. Add **"Run Shell Script"** action, set Shell to `/bin/zsh`, Pass input **as arguments**
4. Paste:
   ```bash
   cd "$1"
   antigravity . --remote-debugging-port=9000
   ```
5. Save as `Open with Antigravity (Debug)`
6. Now: right-click folder → **Quick Actions → Open with Antigravity (Debug)**

---

## ✨ Features

### Core
- **Real-Time Mirroring** — 1-second polling, near-instant sync
- **Remote Control** — Send messages, stop generations, switch Modes/Models
- **Scroll Sync** — Phone scrolling syncs to desktop
- **Thought Expansion** — Tap "Thinking..." blocks to expand/collapse remotely
- **Smart Sync** — Bi-directional Model & Mode synchronization

### Multi-Window
- **🪟 Window Switcher** — Browser-like tabs with long-press reorder
- **📂 Workspace Opener** — Project tiles, one-tap open new windows
- **⚡ Workflow Launcher** — All `/workflows` accessible as chips
- **💬 Per-Project Tabs** — Conversation tabs stored per window

### UI & Access
- **Premium Mobile UI** — Dark-themed, touch-optimized
- **🧹 Clean View** — Filters desktop-only UI elements
- **📜 Chat History** — Full-screen history with search
- **➕ One-Tap New Chat** — Instant new conversations
- **🌍 Remote Access** — Tailscale (recommended) or ngrok tunnel
- **🔒 HTTPS** — Self-signed SSL certificates

---

## 🏗️ Architecture

```
Phone (Safari/Chrome)
    │
    ├─── HTTPS (3001) ──→ Express Server
    ├─── HTTP  (3002) ──→ (Tailscale fallback)
    │                  │
    │                  ├── /windows ────→ CDP Discovery (port 9000)
    │                  ├── /switch-window → CDP WebSocket switch
    │                  ├── /open-workspace → spawn antigravity
    │                  ├── /list-projects → fs.readdir(PROJECTS_DIR)
    │                  ├── /list-workflows → read .agent/workflows/
    │                  ├── /snapshot ────→ CDP Page.captureScreenshot
    │                  ├── /send ────────→ CDP Runtime.evaluate (input)
    │                  ├── /scroll ──────→ CDP Runtime.evaluate (scroll)
    │                  └── WebSocket ───→ Real-time updates
    │
    └─── Antigravity Windows (CDP on port 9000)
```

---

## 📂 Project Structure

```
ag-phone-connect/
├── server.js                         # Main server (Express + CDP + WebSocket)
├── ui_inspector.js                   # UI element inspector
├── launcher.py                       # Unified launcher (local/web modes)
├── generate_ssl.js                   # SSL certificate generator
├── ecosystem.config.cjs              # PM2 process manager config
├── package.json                      # Node.js dependencies
├── .env.example                      # Environment template
├── .gitignore
├── public/
│   ├── index.html                    # Mobile UI
│   ├── css/style.css                 # Dark theme styles
│   ├── js/app.js                     # Frontend logic
│   ├── manifest.json                 # PWA manifest
│   └── icon-512.svg                  # App icon
├── antigravity-debug.bat             # Windows: launch with debug port
├── install_debug_contextmenu.bat     # Windows: add right-click menu
├── install_context_menu.bat          # Windows: general context menu
├── install_context_menu.sh           # Linux: context menu
├── start_ag_phone_connect.bat        # Windows: local launcher
├── start_ag_phone_connect.sh         # macOS/Linux: local launcher
├── start_ag_phone_connect_web.bat    # Windows: remote launcher
├── start_ag_phone_connect_web.sh     # macOS/Linux: remote launcher
└── certs/                            # SSL certificates (generated)
```

---

## 🔧 Troubleshooting

| Issue | Solution |
|---|---|
| **"No Antigravity windows found"** | Ensure Antigravity is running with `--remote-debugging-port=9000` |
| **"Snapshot capture issue"** | Open or start a chat in Antigravity — the server needs an active chat session |
| **Can't connect from phone** | Same Wi-Fi? Try `https://` not `http://`. Accept certificate warning |
| **Port already in use** | The server auto-kills old processes. Or manually: `npx kill-port 3001` |
| **Tailscale: can't connect** | Ensure both devices are on the same Tailscale network. Use `http://` on port 3002 |
| **Workspace opener: path not found** | Set `PROJECTS_DIR` in `.env` to your actual projects folder |
| **Open workspace does nothing** | Set `AG_BIN_PATH` in `.env` to your Antigravity binary path |

---

## 📚 Additional Documentation

- [Code Documentation](CODE_DOCUMENTATION.md) — Architecture, data flow, API
- [Security Guide](SECURITY.md) — HTTPS, certificates, security model
- [Design Philosophy](DESIGN_PHILOSOPHY.md) — Why it was built this way
- [Contributing](CONTRIBUTING.md) — Developer guidelines
- [Release Notes](RELEASE_NOTES.md) — Version history

---

## License

Licensed under the [GNU GPL v3](LICENSE).  
Original: [Antigravity Shit-Chat](https://github.com/gherghett/Antigravity-Shit-Chat) by gherghett  
Extended by **Benji Bazan** (@benjibazan)
