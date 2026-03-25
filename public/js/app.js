// --- Elements ---
const chatContainer = document.getElementById('chatContainer');
const chatContent = document.getElementById('chatContent');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const scrollToBottomBtn = document.getElementById('scrollToBottom');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const refreshBtn = document.getElementById('refreshBtn');
const stopBtn = document.getElementById('stopBtn');
const newChatBtn = document.getElementById('newChatBtn');
const historyBtn = document.getElementById('historyBtn');
const attachBtn = document.getElementById('attachBtn');
const imageInput = document.getElementById('imageInput');
const imagePreviewBar = document.getElementById('imagePreviewBar');

const modeBtn = document.getElementById('modeBtn');
const modelBtn = document.getElementById('modelBtn');
const modalOverlay = document.getElementById('modalOverlay');
const modalList = document.getElementById('modalList');
const modalTitle = document.getElementById('modalTitle');
const modeText = document.getElementById('modeText');
const modelText = document.getElementById('modelText');
const historyLayer = document.getElementById('historyLayer');
const historyList = document.getElementById('historyList');

// --- State ---
let autoRefreshEnabled = true;
let userIsScrolling = false;
let userScrollLockUntil = 0; // Timestamp until which we respect user scroll
let lastScrollPosition = 0;
let ws = null;
let idleTimer = null;
let lastHash = '';
let currentMode = 'Fast';
let chatIsOpen = true; // Track if a chat is currently open
let lastSnapshotTime = 0;
let snapshotPending = false;
let snapshotTimer = null;
const SNAPSHOT_THROTTLE_MS = 2000; // Min time between snapshot updates
let pendingImages = []; // Images waiting to be sent
let isSending = false; // Guard against duplicate sends
let currentWindows = [];
let currentActiveWindowId = null;

// --- Image Attachment ---
attachBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    files.forEach(file => {
        if (!file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = () => {
            pendingImages.push({ name: file.name, data: reader.result, type: file.type });
            renderImagePreviews();
        };
        reader.readAsDataURL(file);
    });
    imageInput.value = ''; // Reset so same file can be re-selected
});

function renderImagePreviews() {
    if (pendingImages.length === 0) {
        imagePreviewBar.style.display = 'none';
        imagePreviewBar.innerHTML = '';
        return;
    }
    imagePreviewBar.style.display = 'flex';
    imagePreviewBar.innerHTML = pendingImages.map((img, i) =>
        '<div class="image-preview-item">' +
        '<img src="' + img.data + '" alt="' + img.name + '">' +
        '<button class="image-preview-remove" onclick="removeImage(' + i + ')">×</button>' +
        '</div>'
    ).join('');
}

function removeImage(index) {
    pendingImages.splice(index, 1);
    renderImagePreviews();
}


// --- Auth Utilities ---
async function fetchWithAuth(url, options = {}) {
    // Add ngrok skip warning header to all requests
    if (!options.headers) options.headers = {};
    options.headers['ngrok-skip-browser-warning'] = 'true';

    try {
        const res = await fetch(url, options);
        if (res.status === 401) {
            console.log('[AUTH] Unauthorized, redirecting to login...');
            window.location.href = '/login.html';
            return new Promise(() => { }); // Halt execution
        }
        return res;
    } catch (e) {
        throw e;
    }
}
const USER_SCROLL_LOCK_DURATION = 15000; // 15 seconds of scroll protection while reading

// --- Sync State (Desktop is Always Priority) ---
async function fetchAppState() {
    try {
        const res = await fetchWithAuth('/app-state');
        const data = await res.json();

        // Mode Sync (Fast/Planning) - Desktop is source of truth
        if (data.mode && data.mode !== 'Unknown') {
            modeText.textContent = data.mode;
            modeBtn.classList.toggle('active', data.mode === 'Planning');
            currentMode = data.mode;
        }

        // Model Sync - Desktop is source of truth
        if (data.model && data.model !== 'Unknown') {
            modelText.textContent = data.model;
        }

        console.log('[SYNC] State refreshed from Desktop:', data);
    } catch (e) { console.error('[SYNC] Failed to sync state', e); }
}

// --- SSL Banner ---
const sslBanner = document.getElementById('sslBanner');

async function checkSslStatus() {
    // Only show banner if currently on HTTP
    if (window.location.protocol === 'https:') return;

    // Check if user dismissed the banner before
    if (localStorage.getItem('sslBannerDismissed')) return;

    sslBanner.style.display = 'flex';
}

async function enableHttps() {
    const btn = document.getElementById('enableHttpsBtn');
    btn.textContent = 'Generating...';
    btn.disabled = true;

    try {
        const res = await fetchWithAuth('/generate-ssl', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            sslBanner.innerHTML = `
                <span>✅ ${data.message}</span>
                <button onclick="location.reload()">Reload After Restart</button>
            `;
            sslBanner.style.background = 'linear-gradient(90deg, #22c55e, #16a34a)';
        } else {
            btn.textContent = 'Failed - Retry';
            btn.disabled = false;
        }
    } catch (e) {
        btn.textContent = 'Error - Retry';
        btn.disabled = false;
    }
}

function dismissSslBanner() {
    sslBanner.style.display = 'none';
    localStorage.setItem('sslBannerDismissed', 'true');
}

// Check SSL on load
checkSslStatus();
// --- Models ---
// Fallback model list (used if dynamic fetch fails)
const FALLBACK_MODELS = [
    "Gemini 3 Pro (High)",
    "Gemini 3 Pro (Low)",
    "Gemini 3 Flash",
    "Claude Opus 4.6",
    "Claude Opus 4.6 (Thinking)",
    "Claude Sonnet 4.6",
    "Claude Sonnet 4.5",
    "Claude Sonnet 4.5 (Thinking)",
    "Claude Opus 4.5 (Thinking)",
    "GPT-OSS 120B (Medium)"
];
let MODELS = [...FALLBACK_MODELS];

// --- WebSocket ---
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        console.log('WS Connected');
        updateStatus(true);
        loadSnapshot();
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'error' && data.message === 'Unauthorized') {
            window.location.href = '/login.html';
            return;
        }
        // Handle snapshot data sent directly via WebSocket (no HTTP round-trip)
        if (data.type === 'snapshot_data' && autoRefreshEnabled && !userIsScrolling) {
            const now = Date.now();
            const elapsed = now - lastSnapshotTime;
            if (elapsed >= SNAPSHOT_THROTTLE_MS) {
                lastSnapshotTime = now;
                applySnapshot(data);
            } else if (!snapshotPending) {
                snapshotPending = true;
                clearTimeout(snapshotTimer);
                snapshotTimer = setTimeout(() => {
                    snapshotPending = false;
                    lastSnapshotTime = Date.now();
                    applySnapshot(data);
                }, SNAPSHOT_THROTTLE_MS - elapsed);
            }
        }
        // Keep legacy support for snapshot_update
        if (data.type === 'snapshot_update' && autoRefreshEnabled && !userIsScrolling) {
            loadSnapshot();
        }
    };

    ws.onclose = () => {
        console.log('WS Disconnected');
        updateStatus(false);
        setTimeout(connectWebSocket, 2000);
    };
}

function updateStatus(connected) {
    if (connected) {
        statusDot.classList.remove('disconnected');
        statusDot.classList.add('connected');
        statusText.textContent = 'Live';
    } else {
        statusDot.classList.remove('connected');
        statusDot.classList.add('disconnected');
        statusText.textContent = 'Reconnecting';
    }
}

// --- Proxy local images in snapshot so phone can display them ---
function proxyLocalImages() {
    const imgs = chatContent.querySelectorAll('img');
    imgs.forEach(img => {
        const src = img.getAttribute('src') || '';
        
        // Rewrite file:/// URIs to use server proxy
        if (src.startsWith('file:///')) {
            const absPath = src.replace('file://', '');
            img.setAttribute('src', `/api/serve-image?path=${encodeURIComponent(absPath)}`);
            img.style.maxWidth = '100%';
            img.style.height = 'auto';
            img.style.borderRadius = '8px';
        }
        // Handle vscode-resource or other local schemes
        else if (src.startsWith('vscode-resource:') || src.startsWith('vscode-file:')) {
            const absPath = src.replace(/^vscode-(resource|file):\/\/\//, '/');
            img.setAttribute('src', `/api/serve-image?path=${encodeURIComponent(absPath)}`);
            img.style.maxWidth = '100%';
            img.style.height = 'auto';
        }
        // Hide unresolvable images (blob:, chrome-extension:, etc.)
        else if (src.startsWith('blob:') || src.startsWith('chrome-extension:') || 
                 src.startsWith('chrome:') || src === '') {
            img.style.display = 'none';
        }
        
        // Add error handler to hide broken images
        img.onerror = () => { img.style.display = 'none'; };
    });
}

// --- Event delegation for "Open" buttons on artifact cards ---
function setupArtifactOpenHandlers() {
    // Use event delegation on chatContent instead of per-button handlers
    // This catches clicks on any "Open" text in the snapshot
    chatContent.addEventListener('click', handleArtifactClick);
    chatContent.addEventListener('touchend', handleArtifactClick);
}

let _artifactHandlersSetup = false;
function ensureArtifactHandlers() {
    if (!_artifactHandlersSetup) {
        setupArtifactOpenHandlers();
        _artifactHandlersSetup = true;
    }
}

function handleArtifactClick(e) {
    const target = e.target;
    const text = (target.textContent || '').trim();
    
    // Only handle "Open" clicks
    if (text !== 'Open') return;

    e.preventDefault();
    e.stopPropagation();

    // Walk up to find the artifact card and extract the title
    let artifactTitle = null;
    let card = target.parentElement;
    for (let i = 0; i < 6; i++) {
        if (!card) break;
        const cardText = (card.textContent || '').trim();
        
        // The card contains the title + "Open" + description
        // Extract the title: text before "Open" that isn't part of description
        // Look for short text nodes that are likely titles
        const children = card.querySelectorAll('*');
        for (const child of children) {
            // Skip the button itself and its children
            if (child === target || child.contains(target) || target.contains(child)) continue;
            
            const childText = (child.textContent || '').trim();
            // Title candidates: short text (3-60 chars), not the description (descriptions are long)
            if (childText.length >= 3 && childText.length <= 60 && 
                !childText.includes('Open') && !childText.includes('Proceed') &&
                !childText.includes('Copy') && childText !== text) {
                // Check this is a "leaf" text element (no child elements with text)
                const childChildren = child.querySelectorAll('*');
                let isLeaf = true;
                for (const cc of childChildren) {
                    if ((cc.textContent || '').trim().length > 0) { isLeaf = false; break; }
                }
                if (isLeaf || child.children.length === 0) {
                    artifactTitle = childText;
                    break;
                }
            }
        }
        if (artifactTitle) break;
        card = card.parentElement;
    }

    if (!artifactTitle) {
        console.log('Could not extract artifact title');
        return;
    }

    // Remove any emoji at the start and "📋" type chars
    artifactTitle = artifactTitle.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\s]+/u, '').trim();
    console.log('Opening artifact:', artifactTitle);

    // Search the server for this artifact
    openArtifactByTitle(artifactTitle);
}

async function openArtifactByTitle(title) {
    try {
        const res = await fetchWithAuth(`/api/find-artifact?title=${encodeURIComponent(title)}`);
        const data = await res.json();
        
        if (data.found && data.content) {
            // Show in the markdown viewer
            filesViewingFile = true;
            filesNavStack.push(filesCurrentDir);
            filesTitle.textContent = data.name || title;
            filesLayer.classList.add('show');
            
            // Render markdown content
            const rendered = typeof marked !== 'undefined' ? marked.parse(data.content) : 
                data.content.replace(/\n/g, '<br>');
            
            filesContent.innerHTML = `
                <div style="padding: 16px 20px; font-size: 14px; line-height: 1.7; color: #e2e8f0;">
                    <style>
                        .md-viewer h1 { font-size: 1.5em; font-weight: 700; margin: 16px 0 8px; color: #f1f5f9; border-bottom: 1px solid #334155; padding-bottom: 8px; }
                        .md-viewer h2 { font-size: 1.3em; font-weight: 600; margin: 14px 0 6px; color: #f1f5f9; }
                        .md-viewer h3 { font-size: 1.1em; font-weight: 600; margin: 12px 0 4px; color: #f1f5f9; }
                        .md-viewer p { margin: 8px 0; }
                        .md-viewer ul, .md-viewer ol { padding-left: 20px; margin: 8px 0; }
                        .md-viewer li { margin: 4px 0; }
                        .md-viewer code { background: rgba(59,130,246,0.15); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
                        .md-viewer pre { background: #1e293b; padding: 12px; border-radius: 8px; overflow-x: auto; margin: 8px 0; }
                        .md-viewer pre code { background: none; padding: 0; }
                        .md-viewer blockquote { border-left: 3px solid #3b82f6; padding: 8px 12px; margin: 8px 0; background: rgba(59,130,246,0.1); }
                        .md-viewer a { color: #60a5fa; }
                        .md-viewer table { border-collapse: collapse; width: 100%; margin: 8px 0; }
                        .md-viewer th, .md-viewer td { border: 1px solid #334155; padding: 6px 8px; }
                        .md-viewer th { background: #1e293b; }
                        .md-viewer hr { border: none; border-top: 1px solid #334155; margin: 16px 0; }
                    </style>
                    <div class="md-viewer">${rendered}</div>
                </div>`;
        } else {
            // Show error with available files
            const availableHtml = data.available?.length ? 
                '<br><br>Available files:<br>' + data.available.map(f => 
                    `<a href="#" style="color: #60a5fa; display: block; padding: 4px 0;" onclick="event.preventDefault(); openMarkdownFile('${f}')">${f}</a>`
                ).join('') : '';
            
            filesViewingFile = true;
            filesTitle.textContent = 'Not Found';
            filesLayer.classList.add('show');
            filesContent.innerHTML = `<div style="padding: 40px 20px; text-align: center; color: #94a3b8;">
                Could not find artifact: "${title}"${availableHtml}
            </div>`;
        }
    } catch (e) {
        console.error('Find artifact error:', e);
    }
}

// --- Post-process snapshot to make .md artifact links clickable ---
function makeArtifactLinksClickable() {
    // Find all links in the chat content
    const links = chatContent.querySelectorAll('a[href]');
    links.forEach(link => {
        const href = link.getAttribute('href') || '';

        // Match file:/// links to .md files
        if (href.startsWith('file:///') && href.endsWith('.md')) {
            const absPath = href.replace('file://', '');
            link.setAttribute('href', '#');
            link.style.cssText = 'color: #60a5fa !important; cursor: pointer; text-decoration: underline; background: rgba(59,130,246,0.1); padding: 2px 6px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px;';
            link.innerHTML = '📄 ' + link.textContent;
            link.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openAbsoluteFile(absPath); };
            return;
        }

        // Match relative brain/ links to .md files
        if (href.endsWith('.md') && (href.includes('brain') || href.includes('.gemini'))) {
            const brainMatch = href.match(/brain[\\/](.+\.md)/);
            if (brainMatch) {
                const relativePath = brainMatch[1].replace(/\\/g, '/');
                link.setAttribute('href', '#');
                link.style.cssText = 'color: #60a5fa !important; cursor: pointer; text-decoration: underline; background: rgba(59,130,246,0.1); padding: 2px 6px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px;';
                link.innerHTML = '📄 ' + link.textContent;
                link.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openMarkdownFile(relativePath); };
            }
        }
    });

    // Note: "Open" buttons on artifact cards are handled by event delegation
    // in handleArtifactClick() - no per-button setup needed here

    // Also find text nodes mentioning .md file paths and wrap them
    const walker = document.createTreeWalker(chatContent, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    let node;
    while (node = walker.nextNode()) {
        if (node.textContent.match(/[\w/\\.-]+\.md/)) {
            textNodes.push(node);
        }
    }
    textNodes.forEach(textNode => {
        const text = textNode.textContent;
        // Match paths like brain/uuid/file.md or just file.md within artifact context
        const regex = /(?:brain[\\/])?([\w-]+[\\/][\w_.-]+\.md)/g;
        let match;
        const matches = [];
        while (match = regex.exec(text)) {
            if (text.includes('brain') || text.includes('.gemini') || text.includes('artifact')) {
                matches.push({ index: match.index, fullMatch: match[0], path: match[1] || match[0] });
            }
        }
        if (matches.length === 0) return;

        // Only process if in an element that isn't already a link
        if (textNode.parentElement && textNode.parentElement.tagName === 'A') return;

        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        matches.forEach(m => {
            if (m.index > lastIndex) {
                fragment.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
            }
            const btn = document.createElement('a');
            btn.href = '#';
            btn.textContent = '📄 ' + m.path.split(/[\\/]/).pop();
            btn.style.cssText = 'color: #60a5fa; cursor: pointer; text-decoration: underline; background: rgba(59,130,246,0.1); padding: 2px 6px; border-radius: 4px;';
            btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openMarkdownFile(m.path.replace(/\\/g, '/')); };
            fragment.appendChild(btn);
            lastIndex = m.index + m.fullMatch.length;
        });
        if (lastIndex < text.length) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
        }
        textNode.parentNode.replaceChild(fragment, textNode);
    });
}

// Open a markdown file by absolute path
async function openAbsoluteFile(absPath) {
    filesViewingFile = true;
    filesNavStack.push(filesCurrentDir);
    const fileName = absPath.split(/[\\/]/).pop();
    filesTitle.textContent = fileName;
    filesLayer.classList.add('show');

    filesContent.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; color: white;">
            <div class="loading-spinner"></div>
            <p style="margin-top: 10px; opacity: 0.7;">Loading ${escapeHtml(fileName)}...</p>
        </div>
    `;

    try {
        const res = await fetchWithAuth(`/api/read-file?path=${encodeURIComponent(absPath)}`);
        const data = await res.json();

        if (data.error) {
            filesContent.innerHTML = `<div style="padding: 20px; color: #ef4444;">${escapeHtml(data.error)}</div>`;
            return;
        }

        const rendered = renderMarkdown(data.content);
        filesContent.innerHTML = `<div class="md-viewer">${rendered}</div>`;
    } catch (e) {
        console.error('File read error:', e);
        filesContent.innerHTML = `<div style="padding: 20px; color: #ef4444;">Error reading file</div>`;
    }
}

// --- CSS Injection (cached, only runs once) ---
let _cssInjected = false;
function injectCSSOnce(baseCss) {
    if (_cssInjected) return;
    _cssInjected = true;

    let styleTag = document.getElementById('cdp-styles');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'cdp-styles';
        document.head.appendChild(styleTag);
    }

    styleTag.textContent = '/* --- BASE SNAPSHOT CSS --- */\n' +
        (baseCss || '') + // Use baseCss if provided, otherwise empty string
        '\n\n/* --- FORCE DARK MODE OVERRIDES --- */\n' +
        ':root {\n' +
        '    --bg-app: #0f172a;\n' +
        '    --text-main: #f8fafc;\n' +
        '    --text-muted: #94a3b8;\n' +
        '    --border-color: #334155;\n' +
        '}\n' +
        '\n' +
        '#conversation, #chat, #cascade {\n' +
        '    background-color: transparent !important;\n' +
        '    color: var(--text-main) !important;\n' +
        '    font-family: \'Inter\', system-ui, sans-serif !important;\n' +
        '    position: relative !important;\n' +
        '    height: auto !important;\n' +
        '    width: 100% !important;\n' +
        '}\n' +
        '\n' +
        '#conversation *, #chat *, #cascade * {\n' +
        '    position: static !important;\n' +
        '}\n' +
        '\n' +
        '#conversation p, #chat p, #cascade p, #conversation h1, #chat h1, #cascade h1, #conversation h2, #chat h2, #cascade h2, #conversation h3, #chat h3, #cascade h3, #conversation h4, #chat h4, #cascade h4, #conversation h5, #chat h5, #cascade h5, #conversation span, #chat span, #cascade span, #conversation div, #chat div, #cascade div, #conversation li, #chat li, #cascade li {\n' +
        '    color: inherit !important;\n' +
        '}\n' +
        '\n' +
        '#conversation a, #chat a, #cascade a {\n' +
        '    color: #60a5fa !important;\n' +
        '    text-decoration: underline;\n' +
        '}\n' +
        '\n' +
        '/* Fix Inline Code - Ultra-compact */\n' +
        ':not(pre) > code {\n' +
        '    padding: 0px 2px !important;\n' +
        '    border-radius: 2px !important;\n' +
        '    background-color: rgba(255, 255, 255, 0.1) !important;\n' +
        '    font-size: 0.82em !important;\n' +
        '    line-height: 1 !important;\n' +
        '    white-space: normal !important;\n' +
        '}\n' +
        '\n' +
        'pre, code, .monaco-editor-background, [class*="terminal"] {\n' +
        '    background-color: #1e293b !important;\n' +
        '    color: #e2e8f0 !important;\n' +
        '    font-family: \'JetBrains Mono\', monospace !important;\n' +
        '    border-radius: 3px;\n' +
        '    border: 1px solid #334155;\n' +
        '}\n' +
        '                \n' +
        '/* Multi-line Code Block - Minimal */\n' +
        'pre {\n' +
        '    position: relative !important;\n' +
        '    white-space: pre-wrap !important; \n' +
        '    word-break: break-word !important;\n' +
        '    padding: 4px 6px !important;\n' +
        '    margin: 2px 0 !important;\n' +
        '    display: block !important;\n' +
        '    width: 100% !important;\n' +
        '}\n' +
        '                \n' +
        'pre.has-copy-btn {\n' +
        '    padding-right: 28px !important;\n' +
        '}\n' +
        '                \n' +
        '/* Single-line Code Block - Minimal */\n' +
        'pre.single-line-pre {\n' +
        '    display: inline-block !important;\n' +
        '    width: auto !important;\n' +
        '    max-width: 100% !important;\n' +
        '    padding: 0px 4px !important;\n' +
        '    margin: 0px !important;\n' +
        '    vertical-align: middle !important;\n' +
        '    background-color: #1e293b !important;\n' +
        '    font-size: 0.85em !important;\n' +
        '}\n' +
        '                \n' +
        'pre.single-line-pre > code {\n' +
        '    display: inline !important;\n' +
        '    white-space: nowrap !important;\n' +
        '}\n' +
        '                \n' +
        'pre:not(.single-line-pre) > code {\n' +
        '    display: block !important;\n' +
        '    width: 100% !important;\n' +
        '    overflow-x: auto !important;\n' +
        '    background: transparent !important;\n' +
        '    border: none !important;\n' +
        '    padding: 0 !important;\n' +
        '    margin: 0 !important;\n' +
        '}\n' +
        '                \n' +
        '.mobile-copy-btn {\n' +
        '    position: absolute !important;\n' +
        '    top: 2px !important;\n' +
        '    right: 2px !important;\n' +
        '    background: rgba(30, 41, 59, 0.5) !important;\n' +
        '    color: #94a3b8 !important;\n' +
        '    border: none !important;\n' +
        '    width: 24px !important; \n' +
        '    height: 24px !important;\n' +
        '    padding: 0 !important;\n' +
        '    cursor: pointer !important;\n' +
        '    display: flex !important;\n' +
        '    align-items: center !important;\n' +
        '    justify-content: center !important;\n' +
        '    border-radius: 4px !important;\n' +
        '    transition: all 0.2s ease !important;\n' +
        '    -webkit-tap-highlight-color: transparent !important;\n' +
        '    z-index: 10 !important;\n' +
        '    margin: 0 !important;\n' +
        '}\n' +
        '                \n' +
        '.mobile-copy-btn:hover,\n' +
        '.mobile-copy-btn:focus {\n' +
        '    background: rgba(59, 130, 246, 0.2) !important;\n' +
        '    color: #60a5fa !important;\n' +
        '}\n' +
        '                \n' +
        '.mobile-copy-btn svg {\n' +
        '    width: 16px !important;\n' +
        '    height: 16px !important;\n' +
        '    stroke: currentColor !important;\n' +
        '    stroke-width: 2 !important;\n' +
        '    fill: none !important;\n' +
        '}\n' +
        '                \n' +
        'blockquote {\n' +
        '    border-left: 3px solid #3b82f6 !important;\n' +
        '    background: rgba(59, 130, 246, 0.1) !important;\n' +
        '    color: #cbd5e1 !important;\n' +
        '    padding: 8px 12px !important;\n' +
        '    margin: 8px 0 !important;\n' +
        '}\n' +
        '\n' +
        'table {\n' +
        '    border-collapse: collapse !important;\n' +
        '    width: 100% !important;\n' +
        '    border: 1px solid #334155 !important;\n' +
        '}\n' +
        'th, td {\n' +
        '    border: 1px solid #334155 !important;\n' +
        '    padding: 8px !important;\n' +
        '    color: #e2e8f0 !important;\n' +
        '}\n' +
        '\n' +
        '::-webkit-scrollbar {\n' +
        '    width: 0 !important;\n' +
        '}\n' +
        '                \n' +
        '[style*="background-color: rgb(255, 255, 255)"],\n' +
        '[style*="background-color: white"],\n' +
        '[style*="background: white"] {\n' +
        '    background-color: transparent !important;\n' +
        '}';
}

// --- Core rendering: apply snapshot data to DOM ---
function applySnapshot(data) {
    // Discard snapshots from a different window (race condition during switch)
    if (data.windowId && currentActiveWindowId && data.windowId !== currentActiveWindowId) {
        console.log('[SNAPSHOT] Discarding stale snapshot from', data.projectName || data.windowId);
        return;
    }

    chatIsOpen = true;

    // Capture scroll state BEFORE updating content
    const scrollPos = chatContainer.scrollTop;
    const scrollHeight = chatContainer.scrollHeight;
    const clientHeight = chatContainer.clientHeight;
    const isNearBottom = scrollHeight - scrollPos - clientHeight < 120;
    const isUserScrollLocked = Date.now() < userScrollLockUntil;

    // --- UPDATE STATS ---
    if (data.stats) {
        const kbs = Math.round((data.stats.htmlSize || 0) / 1024);
        const nodes = data.stats.nodes;
        const statsText = document.getElementById('statsText');
        if (statsText) statsText.textContent = `${nodes} Nodes · ${kbs}KB`;
    }

    // Inject CSS once (cached)
    injectCSSOnce(data.css);

    // Update HTML
    chatContent.innerHTML = data.html;

    // Setup delegated handlers (only once)
    ensureArtifactHandlers();

    // Smart scroll behavior: respect user scroll, only auto-scroll when near bottom
    if (isUserScrollLocked) {
        chatContainer.scrollTop = scrollPos;
    } else if (isNearBottom) {
        scrollToBottom();
    } else {
        chatContainer.scrollTop = scrollPos;
    }

    // Defer post-processing to next frame so HTML renders immediately
    requestAnimationFrame(() => {
        proxyLocalImages();
        makeArtifactLinksClickable();
        addMobileCopyButtons();
    });
}

// --- Rendering (HTTP fallback for initial load) ---
async function loadSnapshot() {
    try {
        const icon = refreshBtn.querySelector('svg');
        icon.classList.add('spin-anim');
        setTimeout(() => icon.classList.remove('spin-anim'), 600);

        const response = await fetchWithAuth('/snapshot');
        if (!response.ok) {
            if (response.status === 503) {
                chatIsOpen = false;
                showEmptyState();
                return;
            }
            throw new Error('Failed to load');
        }

        const data = await response.json();
        applySnapshot(data);
    } catch (err) {
        console.error(err);
    }
}

// --- Mobile Code Block Copy Functionality ---
function addMobileCopyButtons() {
    // Find all pre elements (code blocks) in the chat
    const codeBlocks = chatContent.querySelectorAll('pre');

    codeBlocks.forEach((pre, index) => {
        // Skip if already has our button
        if (pre.querySelector('.mobile-copy-btn')) return;

        // Get the code text
        const codeElement = pre.querySelector('code') || pre;
        const textToCopy = (codeElement.textContent || codeElement.innerText).trim();

        // Check if there's a newline character in the TRIMMED text
        // This ensures single-line blocks with trailing newlines don't get buttons
        const hasNewline = /\n/.test(textToCopy);

        // If it's a single line code block, don't add the copy button
        if (!hasNewline) {
            pre.classList.remove('has-copy-btn');
            pre.classList.add('single-line-pre');
            return;
        }

        // Add class for padding
        pre.classList.remove('single-line-pre');
        pre.classList.add('has-copy-btn');

        // Create the copy button (icon only)
        const copyBtn = document.createElement('button');
        copyBtn.className = 'mobile-copy-btn';
        copyBtn.setAttribute('data-code-index', index);
        copyBtn.setAttribute('aria-label', 'Copy code');
        copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            `;

        // Add click handler for copy
        copyBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const success = await copyToClipboard(textToCopy);

            if (success) {
                // Visual feedback - show checkmark
                copyBtn.classList.add('copied');
                copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            `;

                // Reset after 2 seconds
                setTimeout(() => {
                    copyBtn.classList.remove('copied');
                    copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
            `;
                }, 2000);
            } else {
                // Show X icon briefly on error
                copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
            `;
                setTimeout(() => {
                    copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
            `;
                }, 2000);
            }
        });

        // Insert button into pre element
        pre.appendChild(copyBtn);
    });
}

// --- Cross-platform Clipboard Copy ---
async function copyToClipboard(text) {
    // Method 1: Modern Clipboard API (works on HTTPS or localhost)
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            console.log('[COPY] Success via Clipboard API');
            return true;
        } catch (err) {
            console.warn('[COPY] Clipboard API failed:', err);
        }
    }

    // Method 2: Fallback using execCommand (works on HTTP, older browsers)
    try {
        const textArea = document.createElement('textarea');
        textArea.value = text;

        // Avoid scrolling to bottom on iOS
        textArea.style.position = 'fixed';
        textArea.style.top = '0';
        textArea.style.left = '0';
        textArea.style.width = '2em';
        textArea.style.height = '2em';
        textArea.style.padding = '0';
        textArea.style.border = 'none';
        textArea.style.outline = 'none';
        textArea.style.boxShadow = 'none';
        textArea.style.background = 'transparent';
        textArea.style.opacity = '0';

        document.body.appendChild(textArea);

        // iOS specific handling
        if (navigator.userAgent.match(/ipad|iphone/i)) {
            const range = document.createRange();
            range.selectNodeContents(textArea);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            textArea.setSelectionRange(0, text.length);
        } else {
            textArea.select();
        }

        const success = document.execCommand('copy');
        document.body.removeChild(textArea);

        if (success) {
            console.log('[COPY] Success via execCommand fallback');
            return true;
        }
    } catch (err) {
        console.warn('[COPY] execCommand fallback failed:', err);
    }

    // Method 3: For Android WebView or restricted contexts
    // Show the text in a selectable modal if all else fails
    console.error('[COPY] All copy methods failed');
    return false;
}

function scrollToBottom() {
    chatContainer.scrollTo({
        top: chatContainer.scrollHeight,
        behavior: 'smooth'
    });
}

// --- Inputs ---
async function sendMessage() {
    const message = messageInput.value.trim();
    const images = [...pendingImages];
    if (!message && images.length === 0) return;
    if (isSending) return; // Guard: prevent duplicate sends
    isSending = true;

    // Track message for history (before clearing)
    if (message) trackMessage(message);

    // Optimistic UI updates
    messageInput.value = ''; // Clear immediately
    messageInput.style.height = 'auto'; // Reset height
    messageInput.blur(); // Close keyboard on mobile immediately
    pendingImages = [];
    renderImagePreviews();

    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.5';

    try {
        // If no chat is open, start a new one first
        if (!chatIsOpen) {
            const newChatRes = await fetchWithAuth('/new-chat', { method: 'POST' });
            const newChatData = await newChatRes.json();
            if (newChatData.success) {
                await new Promise(r => setTimeout(r, 800));
                chatIsOpen = true;
            }
        }

        // Upload images first (paste into editor)
        for (const img of images) {
            try {
                const uploadRes = await fetchWithAuth('/upload-image', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image: img.data, filename: img.name })
                });
                const uploadData = await uploadRes.json();
                if (!uploadData.success) {
                    console.warn('Image upload failed:', uploadData.error || 'Unknown error');
                    // Brief visual feedback - flash the send button red
                    sendBtn.style.background = '#ef4444';
                    setTimeout(() => { sendBtn.style.background = ''; }, 1500);
                }
            } catch (uploadErr) {
                console.error('Image upload error:', uploadErr);
                sendBtn.style.background = '#ef4444';
                setTimeout(() => { sendBtn.style.background = ''; }, 1500);
            }
            await new Promise(r => setTimeout(r, 300)); // Brief pause between images
        }

        // Send text message (if any)
        if (message) {
            const res = await fetchWithAuth('/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message })
            });
            if (!res.ok) {
                console.warn('Send response not ok:', await res.json().catch(() => ({})));
            }
        } else if (images.length > 0) {
            // If only images, press Enter to send
            await fetchWithAuth('/send-enter', { method: 'POST' });
        }

        setTimeout(loadSnapshot, 300);
        setTimeout(loadSnapshot, 800);
        setTimeout(checkChatStatus, 1000);
    } catch (e) {
        console.error('Send error:', e);
        setTimeout(loadSnapshot, 500);
    } finally {
        isSending = false;
        sendBtn.disabled = false;
        sendBtn.style.opacity = '1';
    }
}

// --- Event Listeners ---
// Two-tap confirm to prevent accidental sends
let sendConfirmPending = false;
let sendConfirmTimer = null;
const SEND_CONFIRM_TIMEOUT = 3000; // 3 seconds to confirm

sendBtn.addEventListener('click', () => {
    if (isSending) return;
    const message = messageInput.value.trim();
    const images = [...pendingImages];
    if (!message && images.length === 0) return;

    if (!sendConfirmPending) {
        // First tap: show confirmation state
        sendConfirmPending = true;
        sendBtn.style.background = '#f59e0b'; // amber/orange
        sendBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        sendBtn.setAttribute('aria-label', 'Confirm send');

        sendConfirmTimer = setTimeout(() => {
            // Reset if not confirmed within timeout
            sendConfirmPending = false;
            sendBtn.style.background = '';
            sendBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
            sendBtn.setAttribute('aria-label', 'Send');
        }, SEND_CONFIRM_TIMEOUT);
    } else {
        // Second tap: confirm and send
        clearTimeout(sendConfirmTimer);
        sendConfirmPending = false;
        sendBtn.style.background = '';
        sendBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
        sendBtn.setAttribute('aria-label', 'Send');
        sendMessage();
    }
});

refreshBtn.addEventListener('click', () => {
    // Refresh both Chat and State (Mode/Model)
    loadSnapshot();
    fetchAppState(); // PRIORITY: Sync from Desktop
});

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

messageInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
});

// --- Scroll Sync to Desktop ---
let scrollSyncTimeout = null;
let lastScrollSync = 0;
const SCROLL_SYNC_DEBOUNCE = 150; // ms between scroll syncs
let snapshotReloadPending = false;

async function syncScrollToDesktop() {
    const scrollPercent = chatContainer.scrollTop / (chatContainer.scrollHeight - chatContainer.clientHeight);
    try {
        await fetchWithAuth('/remote-scroll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scrollPercent })
        });

        // After scrolling desktop, reload snapshot to get newly visible content
        // (Antigravity uses virtualized scrolling - only visible messages are in DOM)
        if (!snapshotReloadPending) {
            snapshotReloadPending = true;
            setTimeout(() => {
                loadSnapshot();
                snapshotReloadPending = false;
            }, 300);
        }
    } catch (e) {
        console.log('Scroll sync failed:', e.message);
    }
}

chatContainer.addEventListener('scroll', () => {
    userIsScrolling = true;
    // Set a lock to prevent auto-scroll jumping for a few seconds
    userScrollLockUntil = Date.now() + USER_SCROLL_LOCK_DURATION;
    clearTimeout(idleTimer);

    const isNearBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 120;
    if (isNearBottom) {
        scrollToBottomBtn.classList.remove('show');
        // If user scrolled to bottom, clear the lock so auto-scroll works
        userScrollLockUntil = 0;
    } else {
        scrollToBottomBtn.classList.add('show');
    }

    // Debounced scroll sync to desktop
    const now = Date.now();
    if (now - lastScrollSync > SCROLL_SYNC_DEBOUNCE) {
        lastScrollSync = now;
        clearTimeout(scrollSyncTimeout);
        scrollSyncTimeout = setTimeout(syncScrollToDesktop, 100);
    }

    idleTimer = setTimeout(() => {
        userIsScrolling = false;
        autoRefreshEnabled = true;
    }, 5000);
});

scrollToBottomBtn.addEventListener('click', () => {
    userIsScrolling = false;
    userScrollLockUntil = 0; // Clear lock so auto-scroll works again
    scrollToBottom();
});

// --- Quick Actions + Message History (Per-Project) ---

const DEFAULT_QUICK_ACTIONS = [
    { emoji: '▶', label: 'Continue', text: 'Continue' },
    { emoji: '🐛', label: 'Fix Bugs', text: 'Please fix the bugs in this file.' },
    { emoji: '📝', label: 'Docs', text: 'Please create documentation for this.' }
];

const MAX_HISTORY = 20;
let chipLongPressTimer = null;
let chipEditorIndex = -1; // -1 = new chip

function getProjectKey() {
    const win = currentWindows.find(w => w.id === currentActiveWindowId);
    return win?.projectName || win?.title || 'default';
}

function loadQuickActions() {
    const key = `quickActions:${getProjectKey()}`;
    try {
        const saved = localStorage.getItem(key);
        if (saved) return JSON.parse(saved);
    } catch (e) { }
    return [...DEFAULT_QUICK_ACTIONS];
}

function saveQuickActions(actions) {
    const key = `quickActions:${getProjectKey()}`;
    localStorage.setItem(key, JSON.stringify(actions));
}

function loadMsgHistory() {
    const key = `msgHistory:${getProjectKey()}`;
    try {
        const saved = localStorage.getItem(key);
        if (saved) return JSON.parse(saved);
    } catch (e) { }
    return [];
}

function saveMsgHistory(history) {
    const key = `msgHistory:${getProjectKey()}`;
    localStorage.setItem(key, JSON.stringify(history));
}

function trackMessage(text) {
    if (!text || text.length < 2) return;
    const history = loadMsgHistory();
    const existing = history.find(h => h.text === text);
    if (existing) {
        existing.count++;
        existing.lastUsed = Date.now();
    } else {
        history.push({ text, count: 1, lastUsed: Date.now() });
    }
    // Sort by frequency, keep max
    history.sort((a, b) => b.count - a.count);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    saveMsgHistory(history);
}

function quickAction(text) {
    messageInput.value = text;
    messageInput.style.height = 'auto';
    messageInput.style.height = messageInput.scrollHeight + 'px';
    messageInput.focus();
}

function renderQuickActions() {
    const bar = document.getElementById('quickActionsBar');
    if (!bar) return;
    bar.innerHTML = '';

    const actions = loadQuickActions();

    // Render pinned chips
    actions.forEach((action, index) => {
        const chip = document.createElement('div');
        chip.className = 'action-chip';
        chip.textContent = `${action.emoji} ${action.label}`;

        // Tap = fill input
        chip.addEventListener('click', (e) => {
            if (chipLongPressTimer) return; // ignore if was long-pressing
            quickAction(action.text);
        });

        // Long-press = edit
        chip.addEventListener('touchstart', (e) => {
            chip.classList.add('holding');
            chipLongPressTimer = setTimeout(() => {
                chipLongPressTimer = null;
                chip.classList.remove('holding');
                openChipEditor(index, action);
            }, 500);
        }, { passive: true });

        chip.addEventListener('touchend', () => {
            chip.classList.remove('holding');
            if (chipLongPressTimer) {
                clearTimeout(chipLongPressTimer);
                chipLongPressTimer = null;
            }
        });

        chip.addEventListener('touchmove', () => {
            chip.classList.remove('holding');
            if (chipLongPressTimer) {
                clearTimeout(chipLongPressTimer);
                chipLongPressTimer = null;
            }
        });

        bar.appendChild(chip);
    });

    // Recent messages chip
    const history = loadMsgHistory();
    if (history.length > 0) {
        const recentChip = document.createElement('div');
        recentChip.className = 'action-chip recent-chip';
        recentChip.textContent = `📋 Recientes`;
        recentChip.addEventListener('click', showRecentPicker);
        bar.appendChild(recentChip);
    }

    // Workflows chip
    const wfChip = document.createElement('div');
    wfChip.className = 'action-chip workflow-chip';
    wfChip.textContent = '⚡ Workflows';
    wfChip.addEventListener('click', showWorkflowPicker);
    bar.appendChild(wfChip);

    // Add new chip button
    if (actions.length < 6) {
        const addChip = document.createElement('div');
        addChip.className = 'action-chip add-chip';
        addChip.textContent = '+';
        addChip.addEventListener('click', () => openChipEditor(-1, null));
        bar.appendChild(addChip);
    }
}

// --- Chip Editor ---
function openChipEditor(index, action) {
    chipEditorIndex = index;
    const overlay = document.getElementById('chipEditorOverlay');
    const titleEl = document.getElementById('chipEditorTitle');
    const emojiInput = document.getElementById('chipEditorEmoji');
    const labelInput = document.getElementById('chipEditorLabel');
    const textInput = document.getElementById('chipEditorText');
    const deleteBtn = document.getElementById('chipEditorDelete');

    if (action) {
        titleEl.textContent = 'Edit Quick Action';
        emojiInput.value = action.emoji;
        labelInput.value = action.label;
        textInput.value = action.text;
        deleteBtn.style.display = '';
    } else {
        titleEl.textContent = 'New Quick Action';
        emojiInput.value = '';
        labelInput.value = '';
        textInput.value = '';
        deleteBtn.style.display = 'none';
    }

    overlay.style.display = 'flex';
    setTimeout(() => labelInput.focus(), 100);
}

function closeChipEditor() {
    document.getElementById('chipEditorOverlay').style.display = 'none';
}

// Editor event listeners
document.getElementById('chipEditorSave').addEventListener('click', () => {
    const emoji = document.getElementById('chipEditorEmoji').value.trim() || '⚡';
    const label = document.getElementById('chipEditorLabel').value.trim();
    const text = document.getElementById('chipEditorText').value.trim();
    if (!label || !text) return;

    const actions = loadQuickActions();
    const newAction = { emoji, label, text };

    if (chipEditorIndex >= 0 && chipEditorIndex < actions.length) {
        actions[chipEditorIndex] = newAction;
    } else {
        actions.push(newAction);
    }

    saveQuickActions(actions);
    closeChipEditor();
    renderQuickActions();
});

document.getElementById('chipEditorDelete').addEventListener('click', () => {
    if (chipEditorIndex < 0) return;
    const actions = loadQuickActions();
    actions.splice(chipEditorIndex, 1);
    saveQuickActions(actions);
    closeChipEditor();
    renderQuickActions();
});

document.getElementById('chipEditorCancel').addEventListener('click', closeChipEditor);
document.getElementById('chipEditorOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'chipEditorOverlay') closeChipEditor();
});

// --- Recent Messages Picker ---
function showRecentPicker() {
    const picker = document.getElementById('recentPicker');
    const list = document.getElementById('recentList');
    const history = loadMsgHistory();

    list.innerHTML = '';
    if (history.length === 0) {
        list.innerHTML = '<div class="recent-empty">No recent messages yet</div>';
    } else {
        history.forEach(item => {
            const row = document.createElement('div');
            row.className = 'recent-item';
            row.innerHTML = `
                <span class="recent-item-text">${escapeHtml(item.text)}</span>
                <span class="recent-item-count">×${item.count}</span>
            `;
            row.addEventListener('click', () => {
                quickAction(item.text);
                hideRecentPicker();
            });
            list.appendChild(row);
        });
    }

    picker.style.display = 'flex';
}

function hideRecentPicker() {
    document.getElementById('recentPicker').style.display = 'none';
}




// Quick actions are rendered after fetchWindows() loads the correct project key

// --- Stop Logic ---
stopBtn.addEventListener('click', async () => {
    stopBtn.style.opacity = '0.5';
    try {
        const res = await fetchWithAuth('/stop', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            // alert('Stopped');
        } else {
            // alert('Error: ' + data.error);
        }
    } catch (e) { }
    setTimeout(() => stopBtn.style.opacity = '1', 500);
});

// --- New Chat Logic ---
async function startNewChat() {
    newChatBtn.style.opacity = '0.5';
    newChatBtn.style.pointerEvents = 'none';

    try {
        const res = await fetchWithAuth('/new-chat', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            // Reload snapshot to show new empty chat
            setTimeout(loadSnapshot, 500);
            setTimeout(loadSnapshot, 1000);
            setTimeout(checkChatStatus, 1500);
        } else {
            console.error('Failed to start new chat:', data.error);
        }
    } catch (e) {
        console.error('New chat error:', e);
    }

    setTimeout(() => {
        newChatBtn.style.opacity = '1';
        newChatBtn.style.pointerEvents = 'auto';
    }, 500);
}

newChatBtn.addEventListener('click', startNewChat);

// --- Chat History Logic ---
async function showChatHistory() {
    const historyLayer = document.getElementById('historyLayer');
    const historyList = document.getElementById('historyList');

    // Show loading state
    historyList.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; color: white;">
            <div class="loading-spinner"></div>
            <p style="margin-top: 10px; opacity: 0.7;">Loading conversations...</p>
        </div>
    `;
    historyLayer.classList.add('show');

    // Model name pattern - filter these out from conversation list
    const MODEL_NAME_RE = /^(gemini|claude|gpt|llama|mistral|deepseek|codestral|command|phi|qwen|o[134])\b/i;

    // Helper to fetch and render history, with optional retry
    const fetchHistory = async (isRetry = false) => {
        try {
            const res = await fetchWithAuth('/chat-history');
            const data = await res.json();

            // Filter out model names that were incorrectly scraped as conversations
            if (data.chats && data.chats.length > 0) {
                data.chats = data.chats.filter(chat => !MODEL_NAME_RE.test(chat.title));
            }

            // If no chats found and not a retry, auto-retry once after a delay
            if (!isRetry && (!data.chats || data.chats.length === 0) && !data.error) {
                historyList.innerHTML = `
                    <div style="padding: 40px 20px; text-align: center; color: white;">
                        <div class="loading-spinner"></div>
                        <p style="margin-top: 10px; opacity: 0.7;">Searching for conversations...</p>
                    </div>
                `;
                await new Promise(r => setTimeout(r, 1500));
                return fetchHistory(true);
            }

            if (data.error || !data.chats || data.chats.length === 0) {
                historyList.innerHTML = `
                    <div style="padding: 40px 20px; text-align: center; color: white;">
                        <div style="font-size: 24px; margin-bottom: 10px;">💬</div>
                        <div style="font-weight: 500; margin-bottom: 5px;">${data.error ? 'Could not load history' : 'No conversations found'}</div>
                        <div style="font-size: 13px; opacity: 0.7; margin-bottom: 20px;">${data.error || 'Send at least one message in a conversation for it to appear here.'}</div>
                        <div class="history-item new-chat-item" onclick="hideChatHistory(); startNewChat();" style="justify-content: center; background: var(--accent); color: white; border:none;">
                            Start New Conversation
                        </div>
                    </div>
                `;
            } else {
                let html = '';
                data.chats.forEach(chat => {
                    const safeTitle = escapeHtml(chat.title);
                    html += `
                        <div class="history-item" style="gap: 8px;">
                            <div style="flex: 1; min-width: 0; cursor: pointer;" onclick="selectChat('${safeTitle.replace(/'/g, "\\\\'")}'); hideChatHistory();">
                                <div style="font-weight: 600; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${safeTitle}</div>
                                <div style="font-size: 12px; color: #94a3b8; margin-top: 2px;">${escapeHtml(chat.date || '')}</div>
                            </div>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity: 0.4; flex-shrink: 0; cursor: pointer;" onclick="selectChat('${safeTitle.replace(/'/g, "\\\'")}'); hideChatHistory();">
                                <polyline points="9 18 15 12 9 6"></polyline>
                            </svg>
                        </div>
                    `;
                });
                html += `
                    <div class="history-item new-chat-item" onclick="hideChatHistory(); startNewChat();" style="justify-content: center; background: var(--accent); color: white; border:none; margin-top: 12px;">
                        + Start New Conversation
                    </div>
                `;
                historyList.innerHTML = html;
            }
        } catch (e) {
            console.error('Chat history error:', e);
            historyList.innerHTML = `
                <div style="padding: 40px 20px; text-align: center; color: white;">
                    <div style="font-size: 24px; margin-bottom: 10px;">⚠️</div>
                    <div style="font-weight: 500; margin-bottom: 5px;">Connection Error</div>
                    <div style="font-size: 13px; opacity: 0.7;">Could not reach the server. Please try again.</div>
                    <br>
                    <div class="history-item new-chat-item" onclick="hideChatHistory(); startNewChat();" style="justify-content: center; background: var(--accent); color: white; border:none;">
                        Start New Conversation
                    </div>
                </div>
            `;
        }
    };

    await fetchHistory();
    setTimeout(() => historyBtn.style.opacity = '1', 300);
}

function hideChatHistory() {
    historyLayer.classList.remove('show');
}

historyBtn.addEventListener('click', showChatHistory);

// --- Select Chat from History ---
async function selectChat(title) {
    try {
        const res = await fetchWithAuth('/select-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        });
        const data = await res.json();

        if (data.success) {
            // Auto-add as a tab when successfully selected
            if (typeof addTab === 'function') addTab(title);
            setTimeout(loadSnapshot, 300);
            setTimeout(loadSnapshot, 800);
            setTimeout(checkChatStatus, 1000);
        } else {
            console.error('Failed to select chat:', data.error);
        }
    } catch (e) {
        console.error('Select chat error:', e);
    }
}

// --- Check Chat Status ---
async function checkChatStatus() {
    try {
        const res = await fetchWithAuth('/chat-status');
        const data = await res.json();

        chatIsOpen = data.hasChat || data.editorFound;

        if (!chatIsOpen) {
            showEmptyState();
        }
    } catch (e) {
        console.error('Chat status check failed:', e);
    }
}

// --- Empty State (No Chat Open) ---
function showEmptyState() {
    chatContent.innerHTML = `
        <div class="empty-state">
            <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                <line x1="9" y1="10" x2="15" y2="10"></line>
            </svg>
            <h2>No Chat Open</h2>
            <p>Start a new conversation or select one from your history to begin chatting.</p>
            <button class="empty-state-btn" onclick="startNewChat()">
                Start New Conversation
            </button>
        </div>
    `;
}

// --- Utility: Escape HTML ---
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// --- Settings Logic ---


function openModal(title, options, onSelect) {
    modalTitle.textContent = title;
    modalList.innerHTML = '';
    options.forEach(opt => {
        const div = document.createElement('div');
        div.className = 'modal-option';
        div.textContent = opt;
        div.onclick = () => {
            onSelect(opt);
            closeModal();
        };
        modalList.appendChild(div);
    });
    modalOverlay.classList.add('show');
}

function closeModal() {
    modalOverlay.classList.remove('show');
}

modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
};

modeBtn.addEventListener('click', () => {
    openModal('Select Mode', ['Fast', 'Planning'], async (mode) => {
        modeText.textContent = 'Setting...';
        try {
            const res = await fetchWithAuth('/set-mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode })
            });
            const data = await res.json();
            if (data.success) {
                currentMode = mode;
                modeText.textContent = mode;
                modeBtn.classList.toggle('active', mode === 'Planning');
            } else {
                alert('Error: ' + (data.error || 'Unknown'));
                modeText.textContent = currentMode;
            }
        } catch (e) {
            modeText.textContent = currentMode;
        }
    });
});

modelBtn.addEventListener('click', () => {
    openModal('Select Model', MODELS, async (model) => {
        const prev = modelText.textContent;
        modelText.textContent = 'Setting...';
        try {
            const res = await fetchWithAuth('/set-model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model })
            });
            const data = await res.json();
            if (data.success) {
                modelText.textContent = model;
            } else {
                alert('Error: ' + (data.error || 'Unknown'));
                modelText.textContent = prev;
            }
        } catch (e) {
            modelText.textContent = prev;
        }
    });
});

// --- Viewport / Keyboard Handling ---
// iOS: When keyboard opens, visualViewport shrinks. We resize body to match
// and prevent the default iOS page scroll that hides content.
if (window.visualViewport) {
    let resizeTimeout = null;

    function handleViewportResize() {
        // Prevent iOS from scrolling the page behind the keyboard
        window.scrollTo(0, 0);

        // Match body height to visible area
        const vh = window.visualViewport.height;
        document.body.style.height = vh + 'px';
    }

    window.visualViewport.addEventListener('resize', () => {
        // Debounce to avoid layout thrashing during keyboard animation
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(handleViewportResize, 80);
    });

    handleViewportResize(); // Init
} else {
    // Fallback for older browsers without visualViewport support
    window.addEventListener('resize', () => {
        document.body.style.height = window.innerHeight + 'px';
    });
    document.body.style.height = window.innerHeight + 'px'; // Init
}

// --- Remote Click Logic (General) ---
// Handles taps on ANY interactive element in the snapshot:
// buttons, links, details/summary, thought toggles, etc.
chatContainer.addEventListener('click', async (e) => {
    // Find the nearest interactive element
    const target = e.target.closest('button, a, summary, details, [role="button"], [onclick]');

    // Also check for thought/thinking toggles in divs/spans
    const thoughtTarget = e.target.closest('div, span, p, summary');

    let clickTarget = null;
    let clickText = '';
    let clickSelector = '';

    if (target) {
        // Direct interactive element (button, link, summary)
        clickTarget = target;
        clickText = (target.innerText || target.textContent || '').trim();
        clickSelector = target.tagName.toLowerCase();
    } else if (thoughtTarget) {
        // Check if it's a thought/thinking toggle
        const text = (thoughtTarget.innerText || '').trim();
        if (/Thought|Thinking/i.test(text) && text.length < 500) {
            clickTarget = thoughtTarget;
            clickText = text;
            clickSelector = thoughtTarget.tagName.toLowerCase();
        }
    }

    if (!clickTarget || !clickText) return;

    // Ignore clicks on very long text (probably content, not a button)
    const firstLine = clickText.split('\n')[0].trim();
    if (firstLine.length > 200) return;

    // Visual feedback - briefly dim and highlight
    clickTarget.style.opacity = '0.5';
    clickTarget.style.outline = '2px solid #3b82f6';
    setTimeout(() => {
        clickTarget.style.opacity = '1';
        clickTarget.style.outline = '';
    }, 400);

    try {
        const response = await fetchWithAuth('/remote-click', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                selector: clickSelector,
                index: 0,
                textContent: firstLine
            })
        });

        // Reload snapshot to reflect the click result
        setTimeout(loadSnapshot, 400);
        setTimeout(loadSnapshot, 800);
        setTimeout(loadSnapshot, 1500);
    } catch (e) {
        console.error('Remote click failed:', e);
    }
});

// --- Markdown File Viewer ---
const filesBtn = document.getElementById('filesBtn');
const filesLayer = document.getElementById('filesLayer');
const filesContent = document.getElementById('filesContent');
const filesTitle = document.getElementById('filesTitle');
const filesBackBtn = document.getElementById('filesBackBtn');
let filesNavStack = []; // navigation stack for back button
let filesCurrentDir = '';
let filesViewingFile = false;

// Simple markdown to HTML renderer
function renderMarkdown(md) {
    let html = md;

    // Escape HTML
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        return `<pre class="md-code-block"><code>${code.trim()}</code></pre>`;
    });

    // Headers (# to ######)
    html = html.replace(/^######\s+(.+)$/gm, '<h6 class="md-h6">$1</h6>');
    html = html.replace(/^#####\s+(.+)$/gm, '<h5 class="md-h5">$1</h5>');
    html = html.replace(/^####\s+(.+)$/gm, '<h4 class="md-h4">$1</h4>');
    html = html.replace(/^###\s+(.+)$/gm, '<h3 class="md-h3">$1</h3>');
    html = html.replace(/^##\s+(.+)$/gm, '<h2 class="md-h2">$1</h2>');
    html = html.replace(/^#\s+(.+)$/gm, '<h1 class="md-h1">$1</h1>');

    // Horizontal rules
    html = html.replace(/^---+$/gm, '<hr class="md-hr">');

    // Blockquotes (> ...)
    html = html.replace(/^&gt;\s+(.+)$/gm, '<blockquote class="md-blockquote">$1</blockquote>');

    // Unordered lists (- item or * item)
    html = html.replace(/^[\-\*]\s+\[x\]\s+(.+)$/gm, '<div class="md-list-item md-done">✅ $1</div>');
    html = html.replace(/^[\-\*]\s+\[\/\]\s+(.+)$/gm, '<div class="md-list-item md-progress">🔄 $1</div>');
    html = html.replace(/^[\-\*]\s+\[\s?\]\s+(.+)$/gm, '<div class="md-list-item md-todo">⬜ $1</div>');
    html = html.replace(/^[\-\*]\s+(.+)$/gm, '<div class="md-list-item">• $1</div>');

    // Sub-items (indented - item)
    html = html.replace(/^\s{2,}[\-\*]\s+(.+)$/gm, '<div class="md-list-item md-sub-item">  ◦ $1</div>');

    // Bold (**text** or __text__)
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italic (*text* or _text_)
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');

    // Inline code (`code`)
    html = html.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');

    // Links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="md-link" target="_blank">$1</a>');

    // Line breaks (double newline = paragraph break)
    html = html.replace(/\n\n/g, '<br><br>');
    html = html.replace(/\n/g, '<br>');

    return html;
}

async function showFilesView(dir = '') {
    filesCurrentDir = dir;
    filesViewingFile = false;
    filesLayer.classList.add('show');

    // Update title based on current directory
    if (dir) {
        const parts = dir.split(/[\\/]/);
        const shortId = parts[0]?.substring(0, 8) + '...';
        filesTitle.textContent = parts.length > 1 ? parts[parts.length - 1] : shortId;
    } else {
        filesTitle.textContent = 'Artifacts';
    }

    filesContent.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; color: white;">
            <div class="loading-spinner"></div>
            <p style="margin-top: 10px; opacity: 0.7;">Loading files...</p>
        </div>
    `;

    try {
        const res = await fetchWithAuth(`/api/files?dir=${encodeURIComponent(dir)}`);
        const data = await res.json();

        if (data.error) {
            filesContent.innerHTML = `<div style="padding: 40px 20px; text-align: center; color: white; opacity: 0.7;">${escapeHtml(data.error)}</div>`;
            return;
        }

        let html = '';

        // Show directories
        if (data.dirs && data.dirs.length > 0) {
            for (const d of data.dirs) {
                const dirPath = dir ? `${dir}/${d.name}` : d.name;
                const shortName = d.name.length > 20 ? d.name.substring(0, 8) + '...' : d.name;
                html += `
                    <div class="history-item" onclick="filesNavStack.push('${escapeHtml(dir)}'); showFilesView('${escapeHtml(dirPath)}')">
                        <div style="flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px;">
                            <span style="font-size: 20px;">📁</span>
                            <div>
                                <div style="font-weight: 600; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(shortName)}</div>
                                <div style="font-size: 12px; color: #94a3b8; margin-top: 2px;">${d.fileCount} file${d.fileCount !== 1 ? 's' : ''}</div>
                            </div>
                        </div>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity: 0.4; flex-shrink: 0;">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </div>
                `;
            }
        }

        // Show files (markdown + images)
        if (data.files && data.files.length > 0) {
            for (const f of data.files) {
                const filePath = dir ? `${dir}/${f.name}` : f.name;
                const sizeKb = (f.size / 1024).toFixed(1);
                const modDate = new Date(f.modified).toLocaleDateString();
                
                if (f.type === 'image') {
                    // Image file — show thumbnail with tap to view full
                    const imgSrc = `/api/serve-image?path=${encodeURIComponent(f.absolutePath)}`;
                    html += `
                        <div class="history-item" onclick="showImageFullscreen('${escapeHtml(f.absolutePath)}', '${escapeHtml(f.name)}')" style="min-height: 60px;">
                            <div style="flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px;">
                                <img src="${imgSrc}" style="width: 44px; height: 44px; border-radius: 6px; object-fit: cover; flex-shrink: 0; background: rgba(255,255,255,0.05);" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                                <span style="font-size: 20px; display: none; width: 44px; height: 44px; align-items: center; justify-content: center;">🖼️</span>
                                <div>
                                    <div style="font-weight: 600; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(f.name)}</div>
                                    <div style="font-size: 12px; color: #94a3b8; margin-top: 2px;">${sizeKb} KB · ${modDate}</div>
                                </div>
                            </div>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity: 0.4; flex-shrink: 0;">
                                <polyline points="9 18 15 12 9 6"></polyline>
                            </svg>
                        </div>
                    `;
                } else {
                    // Markdown file
                    html += `
                        <div class="history-item" onclick="openMarkdownFile('${escapeHtml(filePath)}')">
                            <div style="flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px;">
                                <span style="font-size: 20px;">📄</span>
                                <div>
                                    <div style="font-weight: 600; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(f.name)}</div>
                                    <div style="font-size: 12px; color: #94a3b8; margin-top: 2px;">${sizeKb} KB · ${modDate}</div>
                                </div>
                            </div>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity: 0.4; flex-shrink: 0;">
                                <polyline points="9 18 15 12 9 6"></polyline>
                            </svg>
                        </div>
                    `;
                }
            }
        }

        if (!html) {
            html = `<div style="padding: 40px 20px; text-align: center; color: white; opacity: 0.7;">No files found</div>`;
        }

        filesContent.innerHTML = html;
    } catch (e) {
        console.error('Files listing error:', e);
        filesContent.innerHTML = `<div style="padding: 40px 20px; text-align: center; color: white; opacity: 0.7;">Error loading files</div>`;
    }
}

async function openMarkdownFile(filePath) {
    filesViewingFile = true;
    filesNavStack.push(filesCurrentDir);
    const fileName = filePath.split(/[\\/]/).pop();
    filesTitle.textContent = fileName;
    filesLayer.classList.add('show');

    filesContent.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; color: white;">
            <div class="loading-spinner"></div>
            <p style="margin-top: 10px; opacity: 0.7;">Loading ${escapeHtml(fileName)}...</p>
        </div>
    `;

    try {
        const res = await fetchWithAuth(`/api/file-content?path=${encodeURIComponent(filePath)}`);
        const data = await res.json();

        if (data.error) {
            filesContent.innerHTML = `<div style="padding: 20px; color: #ef4444;">${escapeHtml(data.error)}</div>`;
            return;
        }

        const rendered = renderMarkdown(data.content);
        filesContent.innerHTML = `<div class="md-viewer">${rendered}</div>`;
    } catch (e) {
        console.error('File read error:', e);
        filesContent.innerHTML = `<div style="padding: 20px; color: #ef4444;">Error reading file</div>`;
    }
}

function showImageFullscreen(absolutePath, fileName) {
    const imgSrc = `/api/serve-image?path=${encodeURIComponent(absolutePath)}`;
    
    // Create fullscreen overlay
    const overlay = document.createElement('div');
    overlay.id = 'imageFullscreenOverlay';
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.95); z-index: 10001;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
    `;
    
    overlay.innerHTML = `
        <div style="position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: linear-gradient(to bottom, rgba(0,0,0,0.7), transparent);">
            <span style="color: #f8fafc; font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; margin-right: 8px;">${escapeHtml(fileName)}</span>
            <button onclick="document.getElementById('imageFullscreenOverlay').remove()" style="background: rgba(255,255,255,0.15); border: none; border-radius: 50%; width: 36px; height: 36px; color: white; font-size: 18px; cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center;">✕</button>
        </div>
        <img src="${imgSrc}" style="max-width: 95%; max-height: 80vh; object-fit: contain; border-radius: 8px; touch-action: pinch-zoom;" alt="${escapeHtml(fileName)}">
    `;
    
    // Tap background to close
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
    
    document.body.appendChild(overlay);
}

function hideFilesView() {
    filesLayer.classList.remove('show');
    filesNavStack = [];
    filesViewingFile = false;
}

filesBtn.addEventListener('click', () => {
    filesNavStack = [];
    showFilesView('');
});

filesBackBtn.addEventListener('click', () => {
    if (filesNavStack.length > 0) {
        const prev = filesNavStack.pop();
        if (prev === '__projects_root__') {
            // Back to projects list
            showProjectsBrowser();
            filesNavStack = []; // reset since showProjectsBrowser sets its own stack
        } else if (prev.startsWith('__project__')) {
            // Back to a project subdirectory: __project__<name>__<subdir>
            const parts = prev.split('__');
            const project = parts[2] || '';
            const subdir = parts.slice(3).join('__') || '';
            browseProjectDir(project, subdir);
        } else {
            showFilesView(prev);
        }
    } else {
        hideFilesView();
    }
});

// --- Projects Browser ---
let projectsBrowsingProject = ''; // tracks which project we're browsing into

async function showProjectsBrowser() {
    projectsBrowsingProject = '';
    filesLayer.classList.add('show');
    filesTitle.textContent = 'Proyectos';
    filesContent.innerHTML = `<div style="padding: 40px 20px; text-align: center; color: white;"><div class="loading-spinner"></div><p>Loading projects...</p></div>`;
    filesNavStack = ['__projects_root__'];

    try {
        const res = await fetchWithAuth('/api/projects');
        if (!res.ok) throw new Error('Failed to fetch projects');
        const data = await res.json();

        // --- Action buttons bar ---
        let actionsHtml = `<div style="display:flex;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.1);">`;

        // Button 1: Open/Switch to proyects folder in Antigravity
        const proyectsWindow = (currentWindows || []).find(w =>
            w.projectName === 'proyects' || w.projectName === 'Proyects'
        );
        if (proyectsWindow) {
            actionsHtml += `<button id="btnOpenProyects" style="flex:1;padding:10px 12px;border:none;border-radius:8px;background:rgba(74,222,128,0.2);color:#4ade80;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
                <span style="font-size:14px;">⚡</span> Ir a Proyects
            </button>`;
        } else {
            actionsHtml += `<button id="btnOpenProyects" style="flex:1;padding:10px 12px;border:none;border-radius:8px;background:rgba(59,130,246,0.2);color:#60a5fa;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
                <span style="font-size:14px;">⚡</span> Abrir en AG
            </button>`;
        }

        // Button 2: Create new folder
        actionsHtml += `<button id="btnCreateFolder" style="flex:1;padding:10px 12px;border:none;border-radius:8px;background:rgba(251,191,36,0.2);color:#fbbf24;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
            <span style="font-size:14px;">➕</span> Nueva Carpeta
        </button>`;
        actionsHtml += `</div>`;

        // --- Project list ---
        let listHtml = '';
        if (!data.projects || data.projects.length === 0) {
            listHtml = `<div style="padding: 40px 20px; text-align: center; color: rgba(255,255,255,0.5);">No projects found</div>`;
        } else {
            listHtml = data.projects.map(p => {
                const ago = timeAgo(p.mtime);
                const isOpen = (currentWindows || []).some(w =>
                    w.projectName?.toLowerCase().includes(p.name.toLowerCase()) ||
                    p.name.toLowerCase().includes(w.projectName?.toLowerCase() || '')
                );
                const statusDot = isOpen ? '<span style="color:#4ade80;margin-left:6px;">●</span>' : '';
                return `<div class="files-dir-item" data-project="${escapeHtml(p.name)}" style="cursor:pointer;">
                    <div class="files-dir-icon">📂</div>
                    <div class="files-dir-info">
                        <div class="files-dir-name">${escapeHtml(p.name)}${statusDot}</div>
                        <div class="files-dir-meta">${ago}</div>
                    </div>
                </div>`;
            }).join('');
        }

        filesContent.innerHTML = actionsHtml + listHtml;

        // --- Attach event handlers ---

        // Button: Open/Switch to proyects
        const btnOpen = document.getElementById('btnOpenProyects');
        if (btnOpen) {
            btnOpen.addEventListener('click', () => {
                if (proyectsWindow) {
                    // Switch to existing window
                    filesLayer.classList.remove('show');
                    switchWindow(proyectsWindow.id);
                } else {
                    // Open new Antigravity instance in proyects folder
                    const basePath = data.basePath || '';
                    if (basePath) {
                        openWorkspace(basePath);
                        btnOpen.innerHTML = '<span style="font-size:14px;">⏳</span> Abriendo...';
                        btnOpen.style.opacity = '0.5';
                        btnOpen.disabled = true;
                    }
                }
            });
        }

        // Button: Create new folder
        const btnCreate = document.getElementById('btnCreateFolder');
        if (btnCreate) {
            btnCreate.addEventListener('click', async () => {
                const folderName = prompt('Nombre de la nueva carpeta:');
                if (!folderName || !folderName.trim()) return;

                try {
                    const createRes = await fetchWithAuth('/api/create-project-folder', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: folderName.trim() })
                    });
                    const result = await createRes.json();
                    if (createRes.ok && result.success) {
                        // Refresh the projects list
                        showProjectsBrowser();
                    } else {
                        alert(result.error || 'Error al crear carpeta');
                    }
                } catch (err) {
                    alert('Error: ' + err.message);
                }
            });
        }

        // Click handler: browse into the project directory
        filesContent.querySelectorAll('.files-dir-item').forEach(item => {
            item.addEventListener('click', () => {
                const projName = item.dataset.project;
                filesNavStack.push('__projects_root__');
                browseProjectDir(projName, '');
            });
        });
    } catch (e) {
        filesContent.innerHTML = `<div style="padding: 40px 20px; text-align: center; color: #ff6b6b;">Error: ${e.message}</div>`;
    }
}

async function browseProjectDir(project, subdir) {
    projectsBrowsingProject = project;
    filesTitle.textContent = subdir ? subdir.split('/').pop() : project;
    filesContent.innerHTML = `<div style="padding: 40px 20px; text-align: center; color: white;"><div class="loading-spinner"></div></div>`;

    try {
        const res = await fetchWithAuth(`/api/project-files?project=${encodeURIComponent(project)}&dir=${encodeURIComponent(subdir)}`);
        if (!res.ok) throw new Error('Failed');
        const data = await res.json();

        let html = '';

        // Directories
        for (const d of data.dirs) {
            html += `<div class="files-dir-item" data-subdir="${escapeHtml(subdir ? subdir + '/' + d.name : d.name)}" style="cursor:pointer;">
                <div class="files-dir-icon">📁</div>
                <div class="files-dir-info">
                    <div class="files-dir-name">${escapeHtml(d.name)}</div>
                    <div class="files-dir-meta">${d.fileCount} items</div>
                </div>
            </div>`;
        }

        // Files
        for (const f of data.files) {
            const icon = f.type === 'markdown' ? '📄' : '📝';
            const sizeStr = f.size > 1024 ? `${(f.size / 1024).toFixed(1)}KB` : `${f.size}B`;
            const filePath = subdir ? `${project}/${subdir}/${f.name}` : `${project}/${f.name}`;
            html += `<div class="files-file-item" data-filepath="${escapeHtml(filePath)}" style="cursor:pointer;">
                <div class="files-dir-icon">${icon}</div>
                <div class="files-dir-info">
                    <div class="files-dir-name">${escapeHtml(f.name)}</div>
                    <div class="files-dir-meta">${sizeStr}</div>
                </div>
            </div>`;
        }

        if (!html) {
            html = `<div style="padding: 40px 20px; text-align: center; color: rgba(255,255,255,0.4);">Empty directory</div>`;
        }

        filesContent.innerHTML = html;

        // Dir click → navigate deeper
        filesContent.querySelectorAll('.files-dir-item').forEach(item => {
            item.addEventListener('click', () => {
                filesNavStack.push(`__project__${project}__${subdir}`);
                browseProjectDir(project, item.dataset.subdir);
            });
        });

        // File click → view content
        filesContent.querySelectorAll('.files-file-item').forEach(item => {
            item.addEventListener('click', () => {
                filesNavStack.push(`__project__${project}__${subdir}`);
                viewProjectFile(item.dataset.filepath);
            });
        });
    } catch (e) {
        filesContent.innerHTML = `<div style="padding: 40px 20px; text-align: center; color: #ff6b6b;">Error loading files</div>`;
    }
}

async function viewProjectFile(filePath) {
    const fileName = filePath.split('/').pop();
    filesTitle.textContent = fileName;
    filesViewingFile = true;
    filesContent.innerHTML = `<div style="padding: 40px 20px; text-align: center; color: white;"><div class="loading-spinner"></div></div>`;

    try {
        const res = await fetchWithAuth(`/api/project-file-content?path=${encodeURIComponent(filePath)}`);
        if (!res.ok) throw new Error('Failed to load file');
        const data = await res.json();

        if (data.type === 'markdown') {
            filesContent.innerHTML = `<div class="md-container">${renderMarkdown(data.content)}</div>`;
        } else {
            // Code file — show with syntax highlighting style
            const escaped = data.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            filesContent.innerHTML = `<pre style="padding:16px;font-size:12px;line-height:1.5;color:#e2e8f0;overflow-x:auto;white-space:pre-wrap;word-break:break-word;background:rgba(0,0,0,0.3);border-radius:8px;margin:8px;">${escaped}</pre>`;
        }
    } catch (e) {
        filesContent.innerHTML = `<div style="padding: 40px 20px; text-align: center; color: #ff6b6b;">Error: ${e.message}</div>`;
    }
}

function timeAgo(ms) {
    if (!ms) return '';
    const seconds = Math.floor((Date.now() - ms) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

// --- Init ---
connectWebSocket();
// Sync state initially and every 5 seconds to keep phone in sync with desktop changes
fetchAppState();
setInterval(fetchAppState, 5000);

// Check chat status initially and periodically
checkChatStatus();
setInterval(checkChatStatus, 10000); // Check every 10 seconds

// ===== SIDE PANEL (Window Switcher as Drawer) =====
const sidePanel = document.getElementById('sidePanel');
const sidePanelOverlay = document.getElementById('sidePanelOverlay');
const sidePanelList = document.getElementById('sidePanelList');
const sidePanelClose = document.getElementById('sidePanelClose');
const menuBtn = document.getElementById('menuBtn');
// currentWindows and currentActiveWindowId moved to top State section

function openSidePanel() {
    sidePanel.classList.add('open');
    sidePanelOverlay.classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeSidePanel() {
    sidePanel.classList.remove('open');
    sidePanelOverlay.classList.remove('open');
    document.body.style.overflow = '';
}

function toggleSidePanel() {
    if (sidePanel.classList.contains('open')) {
        closeSidePanel();
    } else {
        openSidePanel();
    }
}

// Button handlers
menuBtn.addEventListener('click', toggleSidePanel);
sidePanelOverlay.addEventListener('click', closeSidePanel);
sidePanelClose.addEventListener('click', closeSidePanel);

// ===== OVERFLOW MENU (⋯ More Options) =====
const overflowBtn = document.getElementById('overflowBtn');
const overflowMenu = document.getElementById('overflowMenu');
const overflowOverlay = document.getElementById('overflowOverlay');

function openOverflowMenu() {
    overflowMenu.classList.add('open');
    overflowOverlay.classList.add('open');
}

function closeOverflowMenu() {
    overflowMenu.classList.remove('open');
    overflowOverlay.classList.remove('open');
}

function toggleOverflowMenu() {
    if (overflowMenu.classList.contains('open')) {
        closeOverflowMenu();
    } else {
        openOverflowMenu();
    }
}

overflowBtn.addEventListener('click', toggleOverflowMenu);
overflowOverlay.addEventListener('click', closeOverflowMenu);

// Auto-close overflow when any item is clicked
overflowMenu.querySelectorAll('.overflow-item').forEach(item => {
    item.addEventListener('click', () => {
        setTimeout(closeOverflowMenu, 150);
    });
});

// Swipe gesture: swipe from left edge to open, swipe left to close
let touchStartX = 0;
let touchStartY = 0;
let swipeTracking = false;

document.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    // Track swipe only from left edge (within 20px) to open, or if panel is open
    swipeTracking = touchStartX < 20 || sidePanel.classList.contains('open');
}, { passive: true });

document.addEventListener('touchend', (e) => {
    if (!swipeTracking) return;
    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - touchStartX;
    const deltaY = Math.abs(touch.clientY - touchStartY);
    
    // Only if horizontal swipe (more X than Y) and sufficient distance
    if (Math.abs(deltaX) > 50 && deltaX > deltaY) {
        if (deltaX > 0 && !sidePanel.classList.contains('open') && touchStartX < 20) {
            // Swipe right from edge → open
            openSidePanel();
        } else if (deltaX < 0 && sidePanel.classList.contains('open')) {
            // Swipe left → close
            closeSidePanel();
        }
    }
    swipeTracking = false;
}, { passive: true });

function updateProjectNameBar() {
    const el = document.getElementById('projectName');
    if (!el) return;
    const active = (currentWindows || []).find(w => w.id === currentActiveWindowId);
    el.textContent = active ? active.projectName : '';
}

async function fetchWindows() {
    try {
        const res = await fetchWithAuth('/windows');
        if (!res.ok) return;
        const data = await res.json();
        currentWindows = data.windows || [];
        currentActiveWindowId = data.activeWindowId;
        updateProjectNameBar();
        renderWindows();
        renderQuickActions(); // Render after windows load so project key is correct
    } catch (e) { /* silent */ }
}

function getOrderedWindows() {
    // Apply user-defined order from localStorage, Manager always first
    const savedOrder = JSON.parse(localStorage.getItem('ag_window_order') || '[]');
    const manager = currentWindows.filter(w => w.isManager);
    const projects = currentWindows.filter(w => !w.isManager);

    if (savedOrder.length > 0) {
        projects.sort((a, b) => {
            const ai = savedOrder.indexOf(a.id);
            const bi = savedOrder.indexOf(b.id);
            if (ai === -1 && bi === -1) return a.projectName.localeCompare(b.projectName);
            if (ai === -1) return 1;
            if (bi === -1) return -1;
            return ai - bi;
        });
    }
    return [...manager, ...projects];
}

function saveWindowOrder() {
    const order = getOrderedWindows().filter(w => !w.isManager).map(w => w.id);
    localStorage.setItem('ag_window_order', JSON.stringify(order));
}

let isClosingWindow = false;
function renderWindows() {
    // Hide menu button if only 1 window
    if (currentWindows.length <= 1) {
        menuBtn.style.display = 'none';
        return;
    }
    menuBtn.style.display = 'flex';
    const ordered = getOrderedWindows();
    sidePanelList.innerHTML = ordered.map(win => {
        const isActive = win.id === currentActiveWindowId;
        const managerClass = win.isManager ? ' manager' : '';
        const closeBtn = win.isManager ? '' : `<button class="side-panel-close-item" data-close-id="${win.id}" data-close-name="${escapeHtml(win.projectName)}" aria-label="Close window" title="Close">✕</button>`;
        return `<div class="side-panel-item${managerClass}${isActive ? ' active' : ''}" 
            data-window-id="${win.id}" data-is-manager="${win.isManager}"
            title="${escapeHtml(win.projectName)}">
            <span class="side-panel-dot"></span>
            <span class="side-panel-item-label">${escapeHtml(win.projectName)}</span>
            ${closeBtn}
        </div>`;
    }).join('');

    // Add click handlers (switch window) — with closing guard
    sidePanelList.querySelectorAll('.side-panel-item').forEach(item => {
        const winId = item.dataset.windowId;
        item.addEventListener('click', (e) => {
            // Don't switch if they tapped the close button or a close is in progress
            if (e.target.closest('.side-panel-close-item')) return;
            if (isClosingWindow) return;
            switchWindow(winId);
        });
    });

    // Add close button handlers (mobile-safe)
    sidePanelList.querySelectorAll('.side-panel-close-item').forEach(btn => {
        // Touch handler for mobile
        btn.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            e.stopImmediatePropagation();
            e.preventDefault();
            if (isClosingWindow) return;
            isClosingWindow = true;
            const winId = btn.dataset.closeId;
            console.log('🗑️ Close tapped (touch):', winId);
            closeWindowById(winId);
            setTimeout(() => { isClosingWindow = false; }, 2000);
        }, { passive: false });
        
        // Click handler for desktop
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.stopImmediatePropagation();
            e.preventDefault();
            if (isClosingWindow) return;
            isClosingWindow = true;
            const winId = btn.dataset.closeId;
            console.log('🗑️ Close clicked:', winId);
            closeWindowById(winId);
            setTimeout(() => { isClosingWindow = false; }, 2000);
        });
    });

    // Add "📂 Proyectos" shortcut at the bottom of the window list
    const projectsShortcut = document.createElement('div');
    projectsShortcut.className = 'side-panel-item projects-shortcut';
    projectsShortcut.innerHTML = `<span style="font-size: 16px; margin-right: 8px;">📂</span><span class="side-panel-item-label">Proyectos</span>`;
    projectsShortcut.style.cssText = 'margin-top: 12px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 12px; opacity: 0.7;';
    projectsShortcut.addEventListener('click', () => {
        closeSidePanel();
        showProjectsBrowser();
    });
    sidePanelList.appendChild(projectsShortcut);

    // Show/hide workspace opener based on whether Manager is active
    if (typeof updateManagerUI === 'function') updateManagerUI();
}

async function closeWindowById(windowId) {
    try {
        const res = await fetchWithAuth('/close-window', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ windowId })
        });
        const data = await res.json();
        if (data.success) {
            console.log('🗑️ Closed window:', data.projectName);
            // Remove from local list immediately (optimistic)
            currentWindows = currentWindows.filter(w => w.id !== windowId);
            renderWindows();
            // If the active window changed, refresh
            if (data.activeWindowId && data.activeWindowId !== currentActiveWindowId) {
                currentActiveWindowId = data.activeWindowId;
                renderWindows();
                loadSnapshot();
                fetchAppState();
                checkChatStatus();
            }
            // Refresh from server
            setTimeout(fetchWindows, 2000);
        } else {
            console.warn('Close window failed:', data.error);
        }
    } catch (e) {
        console.error('Close window error:', e);
    }
}

async function switchWindow(windowId) {
    if (windowId === currentActiveWindowId) return;

    // Close side panel
    closeSidePanel();

    // Clear old snapshot immediately to prevent stale content flash
    const chatContent = document.getElementById('chatContent');
    if (chatContent) chatContent.innerHTML = '<div style="text-align:center;padding:40px;opacity:0.5">Switching window...</div>';

    // Optimistic UI update
    currentActiveWindowId = windowId;
    updateProjectNameBar();
    renderWindows();
    renderQuickActions(); // Show chips for new project

    try {
        const res = await fetchWithAuth('/switch-window', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ windowId })
        });
        const data = await res.json();
        if (data.success) {
            console.log('🪟 Switched to:', data.projectName);

            // Invalidate workflow cache (different project may have different workflows)
            cachedWorkflows = null;

            // Refresh everything for the new window
            loadSnapshot();
            fetchAppState();
            checkChatStatus();
        }
    } catch (e) {
        console.error('Window switch failed:', e);
    }
}

async function openWorkspace(folderPath) {
    if (!folderPath) return;
    try {
        const res = await fetchWithAuth('/open-workspace', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderPath })
        });
        const data = await res.json();
        if (data.success) {
            console.log('📂 Opening workspace:', folderPath);
            // Save to recent workspaces
            const recents = JSON.parse(localStorage.getItem('ag_recent_workspaces') || '[]');
            if (!recents.includes(folderPath)) {
                recents.unshift(folderPath);
                if (recents.length > 10) recents.pop();
                localStorage.setItem('ag_recent_workspaces', JSON.stringify(recents));
            }
            // Poll for new window to appear
            setTimeout(fetchWindows, 3000);
            setTimeout(fetchWindows, 6000);
        }
    } catch (e) {
        console.error('Open workspace failed:', e);
    }
}

// --- Workspace Opener UI ---
const workspaceOpener = document.getElementById('workspaceOpener');
const workspacePathInput = document.getElementById('workspacePath');
const workspaceOpenBtn = document.getElementById('workspaceOpenBtn');
const workspaceProjects = document.getElementById('workspaceProjects');
const quickActionsBar = document.getElementById('quickActionsBar');
const inputSection = document.querySelector('.input-section');
let availableProjects = [];

function updateManagerUI() {
    const isManagerActive = currentWindows.some(w => w.id === currentActiveWindowId && w.isManager);
    if (isManagerActive) {
        workspaceOpener.style.display = 'block';
        quickActionsBar.style.display = 'none';
        inputSection.style.display = 'none';
        fetchProjectList();
    } else {
        workspaceOpener.style.display = 'none';
        quickActionsBar.style.display = '';
        inputSection.style.display = '';
    }
}

let projectsBasePath = '';

async function fetchProjectList() {
    try {
        const res = await fetchWithAuth('/list-projects');
        const data = await res.json();
        availableProjects = data.projects || [];
        projectsBasePath = data.basePath || '';
        renderProjectTiles();
    } catch (e) {
        workspaceProjects.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; padding: 8px;">Could not load projects</div>';
    }
}

function renderProjectTiles() {
    const openNames = currentWindows.filter(w => !w.isManager).map(w => w.projectName.toLowerCase());

    workspaceProjects.innerHTML = availableProjects.map((proj, idx) => {
        const isOpen = openNames.includes(proj.name.toLowerCase());
        return `<div class="project-tile${isOpen ? ' already-open' : ''}" data-proj-idx="${idx}">
            <span class="tile-icon">${isOpen ? '✅' : '📁'}</span>
            <span>${escapeHtml(proj.name)}</span>
        </div>`;
    }).join('');

    // Attach click handlers using JS references (preserves backslash paths)
    workspaceProjects.querySelectorAll('.project-tile:not(.already-open)').forEach(tile => {
        tile.addEventListener('click', () => {
            const idx = parseInt(tile.dataset.projIdx);
            const proj = availableProjects[idx];
            if (proj) openWorkspace(proj.path);
        });
    });
}

workspaceOpenBtn.addEventListener('click', () => {
    let path = workspacePathInput.value.trim();
    if (!path) return;
    // Auto-prepend base path if just a folder name
    if (!path.includes('\\') && !path.includes('/')) {
        path = projectsBasePath ? projectsBasePath + '/' + path : path;
    }
    openWorkspace(path);
    workspacePathInput.value = '';
});

workspacePathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        let path = workspacePathInput.value.trim();
        if (!path) return;
        if (!path.includes('\\') && !path.includes('/')) {
            path = projectsBasePath ? projectsBasePath + '/' + path : path;
        }
        openWorkspace(path);
        workspacePathInput.value = '';
    }
});

// --- Workflow Picker ---
let cachedWorkflows = null;

async function showWorkflowPicker() {
    const picker = document.getElementById('workflowPicker');
    const list = document.getElementById('workflowList');
    // Toggle: if already open, close it
    if (picker.style.display === 'block') {
        picker.style.display = 'none';
        return;
    }
    picker.style.display = 'block';

    // Use cache only if non-empty
    if (cachedWorkflows && cachedWorkflows.length > 0) {
        renderWorkflowList(cachedWorkflows);
        return;
    }

    list.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; padding: 4px;">Loading workflows...</div>';
    try {
        const res = await fetchWithAuth('/list-workflows');
        const data = await res.json();
        const workflows = data.workflows || [];
        if (workflows.length > 0) {
            cachedWorkflows = workflows;
        }
        renderWorkflowList(workflows);
    } catch (e) {
        list.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">Could not load workflows</div>';
    }
}

function renderWorkflowList(workflows) {
    const list = document.getElementById('workflowList');
    list.innerHTML = workflows.map(wf => {
        const safeName = escapeHtml(wf.name);
        return `<div class="workflow-item" onclick="runWorkflow('${safeName}')" title="${escapeHtml(wf.description)}">
            ${safeName}
        </div>`;
    }).join('');
}

function hideWorkflowPicker() {
    document.getElementById('workflowPicker').style.display = 'none';
}

function runWorkflow(name) {
    hideWorkflowPicker();
    // Insert into input field without sending — user can add context
    const input = document.getElementById('messageInput');
    input.value = name + ' ';
    input.focus();
}

// Fetch windows on load and poll for new ones
fetchWindows();
setInterval(fetchWindows, 30000); // Re-discover every 30s

// Show project tiles when Manager is active (triggered by renderWindows -> updateManagerUI)



// (Tab management removed — side panel replaces this functionality)

// ===== TERMINAL =====
const terminalLayer = document.getElementById('terminalLayer');
const terminalOutput = document.getElementById('terminalOutput');
const terminalInput = document.getElementById('terminalInput');
const terminalSendBtn = document.getElementById('terminalSendBtn');
const terminalBtn = document.getElementById('terminalBtn');

let termCmdHistory = [];
let termHistoryIdx = -1;

function showTerminal() {
    terminalLayer.classList.add('show');
    setTimeout(() => terminalInput.focus(), 300);
}

function hideTerminal() {
    terminalLayer.classList.remove('show');
}

function clearTerminal() {
    terminalOutput.innerHTML = '<div class="terminal-welcome">Terminal cleared</div>';
}

function appendTerminalOutput(html) {
    terminalOutput.insertAdjacentHTML('beforeend', html);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

async function runTerminalCommand(cmd) {
    if (!cmd.trim()) return;

    // Add to history
    termCmdHistory.push(cmd);
    termHistoryIdx = termCmdHistory.length;

    // Show command in output
    appendTerminalOutput(`<div class="terminal-cmd-line">$ ${escapeHtml(cmd)}</div>`);

    // Disable input while running
    terminalInput.disabled = true;
    terminalSendBtn.disabled = true;

    try {
        const res = await fetchWithAuth('/api/terminal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: cmd })
        });
        const data = await res.json();

        if (data.stdout) {
            appendTerminalOutput(`<div class="terminal-stdout">${escapeHtml(data.stdout)}</div>`);
        }
        if (data.stderr) {
            appendTerminalOutput(`<div class="terminal-stderr">${escapeHtml(data.stderr)}</div>`);
        }

        const exitClass = data.exitCode !== 0 ? 'error' : '';
        appendTerminalOutput(`<div class="terminal-exit ${exitClass}">exit: ${data.exitCode}${data.signal ? ' (signal: ' + data.signal + ')' : ''}</div>`);

    } catch (e) {
        appendTerminalOutput(`<div class="terminal-stderr">Error: ${escapeHtml(e.message)}</div>`);
    }

    terminalInput.disabled = false;
    terminalSendBtn.disabled = false;
    terminalInput.value = '';
    terminalInput.focus();
}

terminalBtn.addEventListener('click', showTerminal);

terminalSendBtn.addEventListener('click', () => {
    runTerminalCommand(terminalInput.value);
});

terminalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        runTerminalCommand(terminalInput.value);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (termHistoryIdx > 0) {
            termHistoryIdx--;
            terminalInput.value = termCmdHistory[termHistoryIdx];
        }
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (termHistoryIdx < termCmdHistory.length - 1) {
            termHistoryIdx++;
            terminalInput.value = termCmdHistory[termHistoryIdx];
        } else {
            termHistoryIdx = termCmdHistory.length;
            terminalInput.value = '';
        }
    }
});
